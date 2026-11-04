import { Injectable } from '@nestjs/common';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '@shared/db/drizzle.js';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { type Actor, assertAdmin, primaryRole } from '@modules/access/actor.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { type FileCategory, FileTypeRepository, type FileTypeRow } from './file-type.repository.js';
import type { SubjectRow } from './schema.js';
import { SubjectRepository } from './subject.repository.js';

const MAX_SUBJECT_NAME = 60;
const EXT = /^[a-z0-9]{1,10}$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
/** Executable or script-like types are never accepted, whatever an admin configures (10.1). */
const DANGEROUS_EXT = new Set([
  'exe',
  'js',
  'mjs',
  'html',
  'htm',
  'svg',
  'sh',
  'bat',
  'cmd',
  'apk',
  'msi',
  'dll',
  'scr',
  'vbs',
  'ps1',
  'jar',
  'com',
  'lnk',
]);

export function normalizeSubjectName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name || name.length > MAX_SUBJECT_NAME)
    throw AppError.validation('Subject name is required (up to 60 chars)');
  return name;
}

export function normalizeExt(raw: string): string {
  const ext = raw.trim().toLowerCase().replace(/^\./, '');
  if (!EXT.test(ext)) throw AppError.validation('Extension must be 1-10 letters or digits');
  return ext;
}

export interface SubjectPatch {
  name?: string;
  isActive?: boolean;
}

export interface FileTypeInput {
  ext: string;
  isAllowed: boolean;
  category?: FileCategory;
  mime?: string;
}

/** UC-44: admins maintain the subject catalogue (Р-31) and the allowed file types (5.10.3). */
@Injectable()
export class CatalogAdminUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly subjects: SubjectRepository,
    private readonly fileTypes: FileTypeRepository,
    private readonly audit: AuditService,
  ) {}

  async addSubject(actor: Actor, rawName: string): Promise<SubjectRow> {
    assertAdmin(actor);
    const name = normalizeSubjectName(rawName);
    return this.txm.run(async () => {
      const existing = await this.subjects.findByName(name);
      if (existing?.isActive) throw new AppError('CONFLICT', 'Subject already exists');
      if (existing) return this.updateSubject(actor, existing.id, { isActive: true });
      const row = await this.txm
        .runSavepoint(() => this.subjects.insert({ name, createdBy: actor.accountId }))
        .catch((error: unknown) => {
          if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
            throw new AppError('CONFLICT', 'Subject already exists');
          throw error;
        });
      await this.record(actor, 'subject.created', row.id, null, { name });
      return row;
    });
  }

  /** Rename and (de)activation in one transaction; subjects are never deleted (1.4.6). */
  async updateSubject(actor: Actor, id: string, patch: SubjectPatch): Promise<SubjectRow> {
    assertAdmin(actor);
    const name = patch.name === undefined ? undefined : normalizeSubjectName(patch.name);
    if (name === undefined && patch.isActive === undefined) throw AppError.validation('Nothing to change');
    return this.txm.run(async () => {
      const before = await this.subjects.findById(id, { forUpdate: true });
      if (!before) throw AppError.notFound('subject', id);
      const changes: SubjectPatch = {};
      if (name !== undefined && name !== before.name) changes.name = name;
      if (patch.isActive !== undefined && patch.isActive !== before.isActive)
        changes.isActive = patch.isActive;
      if (Object.keys(changes).length === 0) return before;
      const row = await this.txm
        .runSavepoint(() => this.subjects.update(id, changes))
        .catch((error: unknown) => {
          if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
            throw new AppError('CONFLICT', 'Subject already exists');
          throw error;
        });
      await this.record(
        actor,
        'subject.updated',
        id,
        { name: before.name, isActive: before.isActive },
        { name: row!.name, isActive: row!.isActive },
      );
      return row!;
    });
  }

  /** Partial update of the allowed list: toggles and upserts, all in one transaction, de-duplicated by ext. */
  async updateFileTypes(actor: Actor, items: FileTypeInput[]): Promise<FileTypeRow[]> {
    assertAdmin(actor);
    const byExt = new Map<string, FileTypeInput>();
    for (const item of items) {
      if ((item.category === undefined) !== (item.mime === undefined)) {
        throw AppError.validation('category and mime must be given together');
      }
      byExt.set(normalizeExt(item.ext), item);
    }
    return this.txm.run(async () => {
      for (const [ext, item] of byExt) {
        if (DANGEROUS_EXT.has(ext) && item.isAllowed)
          throw AppError.validation(`.${ext} can never be allowed`);
        const before = await this.fileTypes.find(ext);
        if (item.category && item.mime) {
          const mime = item.mime.trim().toLowerCase();
          if (!MIME.test(mime)) throw AppError.validation('Invalid MIME type');
          const row = await this.fileTypes.upsert({
            ext,
            category: item.category,
            mime,
            isAllowed: item.isAllowed,
            updatedBy: actor.accountId,
          });
          if (
            !before ||
            before.category !== row.category ||
            before.mime !== row.mime ||
            before.isAllowed !== row.isAllowed
          ) {
            await this.record(
              actor,
              'file_type.upserted',
              null,
              before && { ext, category: before.category, mime: before.mime, isAllowed: before.isAllowed },
              { ext, category: row.category, mime: row.mime, isAllowed: row.isAllowed },
            );
          }
        } else {
          if (!before) throw AppError.notFound('file type', ext);
          if (before.isAllowed === item.isAllowed) continue;
          await this.fileTypes.setAllowed(ext, item.isAllowed, actor.accountId);
          await this.record(
            actor,
            'file_type.changed',
            null,
            { ext, isAllowed: before.isAllowed },
            { ext, isAllowed: item.isAllowed },
          );
        }
      }
      return this.fileTypes.listAll();
    });
  }

  async setFileTypeAllowed(actor: Actor, ext: string, isAllowed: boolean): Promise<FileTypeRow> {
    await this.updateFileTypes(actor, [{ ext, isAllowed }]);
    return (await this.fileTypes.find(normalizeExt(ext)))!;
  }

  private async record(
    actor: Actor,
    action: string,
    entityId: string | null,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      actorId: actor.accountId,
      actorRole: primaryRole(actor),
      action,
      entityType: action.startsWith('subject') ? 'subject' : 'file_type',
      entityId,
      before,
      after,
      source: actor.source,
      ip: actor.ip,
    });
  }
}
