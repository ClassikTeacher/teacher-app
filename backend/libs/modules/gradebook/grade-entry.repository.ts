import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import {
  gradeEntry,
  gradeEntryHistory,
  type GradeEntryHistoryRow,
  type GradeEntryInsert,
  type GradeEntryRow,
  type HistoryAction,
} from './schema.js';

export type NewGradeEntry = Omit<
  GradeEntryInsert,
  'id' | 'version' | 'deletedAt' | 'createdAt' | 'updatedAt'
>;
export type GradeEntryPatch = Partial<
  Pick<
    GradeEntryRow,
    | 'date'
    | 'category'
    | 'testKindId'
    | 'valueNumeric'
    | 'valueMax'
    | 'scaleValueId'
    | 'parts'
    | 'weight'
    | 'comment'
    | 'lessonId'
    | 'assignmentId'
    | 'status'
    | 'deletedAt'
  >
>;

export interface EntryFilter {
  /** ISO dates, inclusive. */
  from?: string;
  to?: string;
  statuses?: readonly GradeEntryRow['status'][];
  limit?: number;
}

/** Persistence for grade entries and their history (JRN-03, JRN-05). No rules here. */
@Injectable()
export class GradeEntryRepository {
  constructor(private readonly txm: TransactionManager) {}

  async insert(data: NewGradeEntry): Promise<GradeEntryRow> {
    const rows = await this.txm.db
      .insert(gradeEntry)
      .values({ ...data, id: newId() })
      .returning();
    return rows[0]!;
  }

  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<GradeEntryRow | null> {
    const query = this.txm.db.select().from(gradeEntry).where(eq(gradeEntry.id, id)).limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async findByIds(ids: readonly string[]): Promise<GradeEntryRow[]> {
    if (ids.length === 0) return [];
    return this.txm.db
      .select()
      .from(gradeEntry)
      .where(inArray(gradeEntry.id, [...ids]));
  }

  /** Bumps `version` on every change (JRN-05). */
  async update(id: string, patch: GradeEntryPatch): Promise<GradeEntryRow> {
    const rows = await this.txm.db
      .update(gradeEntry)
      .set({ ...patch, version: sql`${gradeEntry.version} + 1` })
      .where(eq(gradeEntry.id, id))
      .returning();
    const row = rows[0];
    if (!row) throw new Error(`grade_entry ${id} not found`);
    return row;
  }

  /** Live entries of a journal, oldest first (date, then creation), optionally within a period. */
  async listByJournal(journalId: string, filter: EntryFilter = {}): Promise<GradeEntryRow[]> {
    const query = this.txm.db
      .select()
      .from(gradeEntry)
      .where(
        and(
          eq(gradeEntry.journalId, journalId),
          isNull(gradeEntry.deletedAt),
          filter.statuses
            ? inArray(gradeEntry.status, [...filter.statuses])
            : eq(gradeEntry.status, 'confirmed'),
          filter.from ? gte(gradeEntry.date, filter.from) : undefined,
          filter.to ? lte(gradeEntry.date, filter.to) : undefined,
        ),
      )
      .orderBy(asc(gradeEntry.date), asc(gradeEntry.createdAt), asc(gradeEntry.id));
    return filter.limit ? query.limit(filter.limit) : query;
  }

  /** Live entries of several journals at once (report, student screens). */
  async listByJournals(journalIds: readonly string[], filter: EntryFilter = {}): Promise<GradeEntryRow[]> {
    if (journalIds.length === 0) return [];
    return this.txm.db
      .select()
      .from(gradeEntry)
      .where(
        and(
          inArray(gradeEntry.journalId, [...journalIds]),
          isNull(gradeEntry.deletedAt),
          filter.statuses
            ? inArray(gradeEntry.status, [...filter.statuses])
            : eq(gradeEntry.status, 'confirmed'),
          filter.from ? gte(gradeEntry.date, filter.from) : undefined,
          filter.to ? lte(gradeEntry.date, filter.to) : undefined,
        ),
      )
      .orderBy(
        asc(gradeEntry.journalId),
        asc(gradeEntry.date),
        asc(gradeEntry.createdAt),
        asc(gradeEntry.id),
      );
  }

  /** Grades the teacher still has to confirm (5.11.2 💡), oldest first. */
  async listPendingByTeacher(teacherId: string, limit = 50): Promise<GradeEntryRow[]> {
    return this.txm.db
      .select()
      .from(gradeEntry)
      .where(
        and(
          eq(gradeEntry.teacherId, teacherId),
          eq(gradeEntry.status, 'pending'),
          isNull(gradeEntry.deletedAt),
        ),
      )
      .orderBy(asc(gradeEntry.createdAt), asc(gradeEntry.id))
      .limit(limit);
  }

  async countPending(teacherId: string, journalId?: string): Promise<number> {
    return this.txm.db.$count(
      gradeEntry,
      and(
        eq(gradeEntry.teacherId, teacherId),
        journalId ? eq(gradeEntry.journalId, journalId) : undefined,
        eq(gradeEntry.status, 'pending'),
        isNull(gradeEntry.deletedAt),
      ),
    );
  }

  /** Whether a scale value is referenced by any live entry (JRN-06). */
  async scaleValueInUse(scaleValueId: string): Promise<boolean> {
    const count = await this.txm.db.$count(
      gradeEntry,
      and(eq(gradeEntry.scaleValueId, scaleValueId), isNull(gradeEntry.deletedAt)),
    );
    return count > 0;
  }

  /** Live entries tied to an assignment for a student (the grade shown on the submission card). */
  async listByAssignment(assignmentId: string, studentId: string): Promise<GradeEntryRow[]> {
    return this.txm.db
      .select()
      .from(gradeEntry)
      .where(
        and(
          eq(gradeEntry.assignmentId, assignmentId),
          eq(gradeEntry.studentId, studentId),
          isNull(gradeEntry.deletedAt),
        ),
      )
      .orderBy(desc(gradeEntry.createdAt));
  }

  /** Confirmed, live entries of a student at a teacher created on a calendar day (NTF-07 digest). */
  async countConfirmedCreatedBetween(
    teacherId: string,
    studentId: string,
    from: Date,
    to: Date,
  ): Promise<number> {
    return this.txm.db.$count(
      gradeEntry,
      and(
        eq(gradeEntry.teacherId, teacherId),
        eq(gradeEntry.studentId, studentId),
        eq(gradeEntry.status, 'confirmed'),
        isNull(gradeEntry.deletedAt),
        gte(gradeEntry.updatedAt, from),
        lte(gradeEntry.updatedAt, to),
      ),
    );
  }

  // --- history ------------------------------------------------------------------------------------

  async addHistory(data: {
    entryId: string;
    changedBy: string | null;
    action: HistoryAction;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    at: Date;
  }): Promise<GradeEntryHistoryRow> {
    const rows = await this.txm.db
      .insert(gradeEntryHistory)
      .values({ ...data, id: newId() })
      .returning();
    return rows[0]!;
  }

  async listHistory(entryId: string): Promise<GradeEntryHistoryRow[]> {
    return this.txm.db
      .select()
      .from(gradeEntryHistory)
      .where(eq(gradeEntryHistory.entryId, entryId))
      .orderBy(asc(gradeEntryHistory.at), asc(gradeEntryHistory.id));
  }
}
