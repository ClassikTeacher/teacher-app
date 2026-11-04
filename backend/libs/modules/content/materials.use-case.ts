import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { type Actor, assertRole } from '@modules/access/actor.js';
import { FeatureService } from '@modules/access/features/feature.service.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { FileMaintenanceJob } from '@modules/files/file-maintenance.job.js';
import { FileRepository } from '@modules/files/file.repository.js';
import { LessonRepository } from '@modules/schedule/lessons/lesson.repository.js';
import { GrantsUseCase } from './grants.use-case.js';
import { MaterialRepository } from './material.repository.js';
import type { CollectionRow, LessonMaterialRow, MaterialRow, Release } from './schema.js';

export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 1000;
export const MAX_BODY_LENGTH = 4000;
export const MAX_URL_LENGTH = 2000;
export const MAX_TAGS = 10;

export type NewMaterialInput = {
  title: string;
  description?: string | null;
  subjectId?: string | null;
  tags?: string[];
} & ({ kind: 'file'; fileId: string } | { kind: 'link'; url: string } | { kind: 'text'; body: string });

export interface NewCollectionInput {
  title: string;
  description?: string | null;
  /** ISO dates `YYYY-MM-DD` (5.9.2 «Материалы за ноябрь»). */
  periodFrom?: string | null;
  periodTo?: string | null;
}

export type LessonMaterialTarget = { materialId: string } | { collectionId: string };

const text = (
  value: string | null | undefined,
  max: number,
  field: string,
  required = false,
): string | null => {
  const clean = (value ?? '').trim();
  if (!clean) {
    if (required) throw AppError.validation(`${field} is required`, { field });
    return null;
  }
  if (clean.length > max) throw AppError.validation(`${field} is too long`, { field, max });
  return clean;
};

/**
 * UC-25 (5.9): the teacher's library — materials of three kinds, flat collections, lesson attachments with
 * a release moment. Ownership follows 8.0 (`teacher_id`); the `materials` feature gates every write.
 */
@Injectable()
export class MaterialsUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly materials: MaterialRepository,
    private readonly files: FileRepository,
    private readonly fileStore: FileMaintenanceJob,
    private readonly lessons: LessonRepository,
    private readonly grants: GrantsUseCase,
    private readonly features: FeatureService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async create(actor: Actor, input: NewMaterialInput): Promise<MaterialRow> {
    assertRole(actor, 'TEACHER');
    await this.features.assertEnabled(actor.accountId, 'materials');
    const title = text(input.title, MAX_TITLE_LENGTH, 'title', true)!;
    const description = text(input.description, MAX_DESCRIPTION_LENGTH, 'description');
    const tags = [...new Set((input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(
      0,
      MAX_TAGS,
    );
    const now = this.clock.now();
    return this.txm.run(async () => {
      let payload: { fileId?: string; url?: string; body?: string };
      if (input.kind === 'file') {
        const attached = await this.files.markAttached([input.fileId], actor.accountId, now);
        if (attached.length !== 1) throw AppError.notFound('file', input.fileId);
        payload = { fileId: input.fileId };
      } else if (input.kind === 'link') {
        payload = { url: this.url(input.url) };
      } else {
        payload = { body: text(input.body, MAX_BODY_LENGTH, 'body', true)! };
      }
      const row = await this.materials.insert({
        teacherId: actor.accountId,
        kind: input.kind,
        title,
        description,
        subjectId: input.subjectId ?? null,
        tags,
        ...payload,
      });
      await this.record(actor, 'material.created', row.id, { kind: row.kind, titleLength: title.length });
      return row;
    });
  }

  /** Archiving hides the material everywhere: its grants are revoked (MAT-02, no message). */
  async archive(actor: Actor, materialId: string): Promise<MaterialRow> {
    assertRole(actor, 'TEACHER');
    return this.txm.run(async () => {
      const row = await this.own(actor, materialId);
      if (row.archivedAt) return row;
      for (const g of await this.grants.listForSubject(actor, 'material', row.id)) {
        await this.grants.revoke(actor, g.id);
      }
      const updated = await this.materials.update(row.id, { archivedAt: this.clock.now() });
      await this.record(actor, 'material.archived', row.id, null);
      return updated;
    });
  }

  /**
   * Deleting a material (Р-27: the teacher frees storage) archives it and removes its file from S3 for good;
   * the row stays as history for lessons and collections that referenced it.
   */
  async delete(actor: Actor, materialId: string): Promise<MaterialRow> {
    const row = await this.archive(actor, materialId);
    if (row.fileId) await this.fileStore.remove(row.fileId);
    await this.record(actor, 'material.deleted', row.id, { kind: row.kind, fileId: row.fileId });
    return row;
  }

  async createCollection(actor: Actor, input: NewCollectionInput): Promise<CollectionRow> {
    assertRole(actor, 'TEACHER');
    await this.features.assertEnabled(actor.accountId, 'materials');
    const title = text(input.title, MAX_TITLE_LENGTH, 'title', true)!;
    if (input.periodFrom && input.periodTo && input.periodFrom > input.periodTo)
      throw AppError.validation('periodFrom must not be after periodTo');
    return this.txm.run(async () => {
      const row = await this.materials.insertCollection({
        teacherId: actor.accountId,
        title,
        description: text(input.description, MAX_DESCRIPTION_LENGTH, 'description'),
        periodFrom: input.periodFrom ?? null,
        periodTo: input.periodTo ?? null,
      });
      await this.record(actor, 'collection.created', row.id, { titleLength: title.length });
      return row;
    });
  }

  /** Archiving a collection revokes its grants (MAT-02); the materials themselves stay in the library. */
  async archiveCollection(actor: Actor, collectionId: string): Promise<CollectionRow> {
    assertRole(actor, 'TEACHER');
    return this.txm.run(async () => {
      const row = await this.ownCollection(actor, collectionId);
      if (row.archivedAt) return row;
      for (const g of await this.grants.listForSubject(actor, 'collection', row.id)) {
        await this.grants.revoke(actor, g.id);
      }
      const updated = await this.materials.updateCollection(row.id, { archivedAt: this.clock.now() });
      await this.record(actor, 'collection.archived', row.id, null);
      return updated;
    });
  }

  /** One material may sit in several collections (5.9.2); adding it twice is a no-op. */
  async addToCollection(actor: Actor, collectionId: string, materialId: string): Promise<void> {
    assertRole(actor, 'TEACHER');
    await this.txm.run(async () => {
      const [col] = await Promise.all([this.ownCollection(actor, collectionId), this.own(actor, materialId)]);
      await this.materials.addItem(col.id, 'material', materialId);
      await this.record(actor, 'collection.item_added', col.id, { materialId });
    });
  }

  async removeFromCollection(actor: Actor, collectionId: string, materialId: string): Promise<void> {
    assertRole(actor, 'TEACHER');
    await this.txm.run(async () => {
      const col = await this.ownCollection(actor, collectionId);
      await this.materials.removeItem(col.id, 'material', materialId);
      await this.record(actor, 'collection.item_removed', col.id, { materialId });
    });
  }

  /**
   * 5.9.3 «Через занятие»: `before` hands the material to the current participants right away (and to anyone
   * who joins later, see LessonContentHandler); `after` waits for the report (`lesson.completed`). Attaching
   * to an already reported lesson hands it out at once whatever the release.
   */
  async attachToLesson(
    actor: Actor,
    lessonId: string,
    target: LessonMaterialTarget,
    release: Release,
  ): Promise<LessonMaterialRow> {
    assertRole(actor, 'TEACHER');
    await this.features.assertEnabled(actor.accountId, 'materials');
    return this.txm.run(async () => {
      const lesson = await this.lessons.findById(lessonId);
      if (!lesson || lesson.teacherId !== actor.accountId) throw AppError.notFound('lesson', lessonId);
      if (lesson.status === 'cancelled') throw new AppError('CONFLICT', 'The lesson is cancelled');
      if ('materialId' in target) await this.own(actor, target.materialId);
      else await this.ownCollection(actor, target.collectionId);
      const row = await this.materials.attachToLesson(lesson.id, target, release);
      const reported = lesson.status === 'completed' || lesson.status === 'not_held';
      if (release === 'before' || reported) {
        const students = (await this.lessons.listParticipants(lesson.id)).map((p) => p.studentId);
        await this.grants.grantFromLesson(actor, lesson.id, students, [target]);
      }
      await this.record(actor, 'lesson.material_attached', lesson.id, { release, ...target });
      return row;
    });
  }

  /** Attachments of the teacher's lesson with their titles (for the lesson screen). */
  async listForLesson(
    actor: Actor,
    lessonId: string,
  ): Promise<Array<{ id: string; release: Release; title: string; target: LessonMaterialTarget }>> {
    assertRole(actor, 'TEACHER');
    const lesson = await this.lessons.findById(lessonId);
    if (!lesson || lesson.teacherId !== actor.accountId) throw AppError.notFound('lesson', lessonId);
    const rows = await this.materials.listLessonMaterials(lesson.id);
    const [materials, collections] = await Promise.all([
      this.materials.findByIds(rows.flatMap((r) => (r.materialId ? [r.materialId] : []))),
      this.materials.findCollections(rows.flatMap((r) => (r.collectionId ? [r.collectionId] : []))),
    ]);
    return rows.map((r) => ({
      id: r.id,
      release: r.release,
      title: r.materialId
        ? (materials.find((m) => m.id === r.materialId)?.title ?? '—')
        : (collections.find((c) => c.id === r.collectionId)?.title ?? '—'),
      target: r.materialId ? { materialId: r.materialId } : { collectionId: r.collectionId! },
    }));
  }

  private url(raw: string): string {
    const value = text(raw, MAX_URL_LENGTH, 'url', true)!;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw AppError.validation('url is not valid', { field: 'url' });
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      throw AppError.validation('url must be http(s)', { field: 'url' });
    return parsed.toString();
  }

  async own(actor: Actor, materialId: string): Promise<MaterialRow> {
    const row = await this.materials.findById(materialId);
    if (!row || row.teacherId !== actor.accountId) throw AppError.notFound('material', materialId);
    return row;
  }

  async ownCollection(actor: Actor, collectionId: string): Promise<CollectionRow> {
    const row = await this.materials.findCollection(collectionId);
    if (!row || row.teacherId !== actor.accountId) throw AppError.notFound('collection', collectionId);
    return row;
  }

  private async record(
    actor: Actor,
    action: string,
    entityId: string,
    after: Record<string, unknown> | null,
  ) {
    await this.audit.record({
      actorId: actor.accountId,
      actorRole: 'TEACHER',
      action,
      entityType: action.split('.')[0]!,
      entityId,
      after,
      source: actor.source,
      ip: actor.ip,
    });
  }
}
