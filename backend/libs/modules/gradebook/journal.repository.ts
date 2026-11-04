import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import {
  gradeScale,
  type GradeScaleRow,
  gradeScaleValue,
  type GradeScaleValueInsert,
  type GradeScaleValueRow,
  journal,
  type JournalInsert,
  type JournalRow,
  type JournalType,
  testKind,
  type TestKindRow,
} from './schema.js';

export type NewJournal = Omit<JournalInsert, 'id' | 'createdAt' | 'updatedAt'>;
export type JournalPatch = Partial<
  Pick<JournalRow, 'visibleToStudent' | 'visibleToParent' | 'hidden' | 'targetScore'>
>;

/** Persistence for journals, scales and test kinds (8.2 «gradebook»). No rules here. */
@Injectable()
export class JournalRepository {
  constructor(private readonly txm: TransactionManager) {}

  // --- journals -----------------------------------------------------------------------------------

  /** Idempotent: an existing `(link, subject, type)` row is kept (JRN-02). Returns the rows created now. */
  async ensure(rows: readonly NewJournal[]): Promise<JournalRow[]> {
    if (rows.length === 0) return [];
    return this.txm.db
      .insert(journal)
      .values(rows.map((r) => ({ ...r, id: newId() })))
      .onConflictDoNothing()
      .returning();
  }

  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<JournalRow | null> {
    const query = this.txm.db.select().from(journal).where(eq(journal.id, id)).limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async findByIds(ids: readonly string[]): Promise<JournalRow[]> {
    if (ids.length === 0) return [];
    return this.txm.db
      .select()
      .from(journal)
      .where(inArray(journal.id, [...ids]));
  }

  async update(id: string, patch: JournalPatch): Promise<JournalRow> {
    const rows = await this.txm.db.update(journal).set(patch).where(eq(journal.id, id)).returning();
    const row = rows[0];
    if (!row) throw new Error(`journal ${id} not found`);
    return row;
  }

  /** Journals of one link (all subjects, all types), stable order. */
  async listByLink(linkId: string): Promise<JournalRow[]> {
    return this.txm.db
      .select()
      .from(journal)
      .where(eq(journal.teacherStudentId, linkId))
      .orderBy(asc(journal.subjectId), asc(journal.type), asc(journal.id));
  }

  async listByLinks(linkIds: readonly string[]): Promise<JournalRow[]> {
    if (linkIds.length === 0) return [];
    return this.txm.db
      .select()
      .from(journal)
      .where(inArray(journal.teacherStudentId, [...linkIds]))
      .orderBy(asc(journal.teacherStudentId), asc(journal.subjectId), asc(journal.type));
  }

  async listByTeacherStudent(teacherId: string, studentId: string): Promise<JournalRow[]> {
    return this.txm.db
      .select()
      .from(journal)
      .where(and(eq(journal.teacherId, teacherId), eq(journal.studentId, studentId)))
      .orderBy(asc(journal.subjectId), asc(journal.type), asc(journal.id));
  }

  async findByLinkSubjectType(
    linkId: string,
    subjectId: string,
    type: JournalType,
  ): Promise<JournalRow | null> {
    const rows = await this.txm.db
      .select()
      .from(journal)
      .where(
        and(eq(journal.teacherStudentId, linkId), eq(journal.subjectId, subjectId), eq(journal.type, type)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  // --- scales -------------------------------------------------------------------------------------

  async findScale(id: string, options: { forUpdate?: boolean } = {}): Promise<GradeScaleRow | null> {
    const query = this.txm.db.select().from(gradeScale).where(eq(gradeScale.id, id)).limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  /** The teacher's live custom scale, if any (one per owner, migration 0018). */
  async findCustomScale(
    ownerId: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<GradeScaleRow | null> {
    const query = this.txm.db
      .select()
      .from(gradeScale)
      .where(
        and(eq(gradeScale.ownerId, ownerId), eq(gradeScale.kind, 'custom'), isNull(gradeScale.archivedAt)),
      )
      .limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async insertScale(data: { ownerId: string; title: string }): Promise<GradeScaleRow> {
    const rows = await this.txm.db
      .insert(gradeScale)
      .values({ id: newId(), ownerId: data.ownerId, kind: 'custom', title: data.title })
      .returning();
    return rows[0]!;
  }

  async updateScale(
    id: string,
    patch: Partial<Pick<GradeScaleRow, 'title' | 'archivedAt'>>,
  ): Promise<GradeScaleRow> {
    const rows = await this.txm.db.update(gradeScale).set(patch).where(eq(gradeScale.id, id)).returning();
    const row = rows[0];
    if (!row) throw new Error(`grade_scale ${id} not found`);
    return row;
  }

  /** Values of a scale in display order; archived ones included unless `liveOnly`. */
  async listScaleValues(scaleId: string, liveOnly = false): Promise<GradeScaleValueRow[]> {
    return this.txm.db
      .select()
      .from(gradeScaleValue)
      .where(
        and(eq(gradeScaleValue.scaleId, scaleId), liveOnly ? isNull(gradeScaleValue.archivedAt) : undefined),
      )
      .orderBy(asc(gradeScaleValue.position), asc(gradeScaleValue.id));
  }

  async findScaleValues(ids: readonly string[]): Promise<GradeScaleValueRow[]> {
    if (ids.length === 0) return [];
    return this.txm.db
      .select()
      .from(gradeScaleValue)
      .where(inArray(gradeScaleValue.id, [...ids]));
  }

  async insertScaleValue(
    data: Omit<GradeScaleValueInsert, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<GradeScaleValueRow> {
    const rows = await this.txm.db
      .insert(gradeScaleValue)
      .values({ ...data, id: newId() })
      .returning();
    return rows[0]!;
  }

  async updateScaleValue(
    id: string,
    patch: Partial<Pick<GradeScaleValueRow, 'label' | 'emoji' | 'position' | 'weight' | 'archivedAt'>>,
  ): Promise<GradeScaleValueRow> {
    const rows = await this.txm.db
      .update(gradeScaleValue)
      .set(patch)
      .where(eq(gradeScaleValue.id, id))
      .returning();
    const row = rows[0];
    if (!row) throw new Error(`grade_scale_value ${id} not found`);
    return row;
  }

  // --- test kinds ---------------------------------------------------------------------------------

  /** Platform kinds plus the teacher's own, live ones, in position order. */
  async listTestKinds(ownerId: string): Promise<TestKindRow[]> {
    const rows = await this.txm.db
      .select()
      .from(testKind)
      .where(and(isNull(testKind.archivedAt)))
      .orderBy(asc(testKind.position), asc(testKind.name));
    return rows.filter((k) => k.ownerId === null || k.ownerId === ownerId);
  }

  async findTestKind(id: string): Promise<TestKindRow | null> {
    const rows = await this.txm.db.select().from(testKind).where(eq(testKind.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async findTestKinds(ids: readonly string[]): Promise<TestKindRow[]> {
    if (ids.length === 0) return [];
    return this.txm.db
      .select()
      .from(testKind)
      .where(inArray(testKind.id, [...ids]));
  }

  async insertTestKind(data: { ownerId: string; name: string; position: number }): Promise<TestKindRow> {
    const rows = await this.txm.db
      .insert(testKind)
      .values({ ...data, id: newId() })
      .returning();
    return rows[0]!;
  }

  async archiveTestKind(id: string, at: Date): Promise<void> {
    await this.txm.db.update(testKind).set({ archivedAt: at }).where(eq(testKind.id, id));
  }
}
