import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import { teacherStudent } from '@modules/people/schema.js';
import {
  type Interval,
  lesson,
  lessonEvent,
  type LessonEventRow,
  type LessonInsert,
  lessonParticipant,
  type LessonParticipantRow,
  type LessonRow,
  type LessonStatus,
} from '../schema.js';

export type NewLesson = Omit<LessonInsert, 'id' | 'createdAt' | 'updatedAt' | 'version'>;
export type LessonPatch = Partial<Omit<LessonInsert, 'id' | 'teacherId' | 'createdAt' | 'updatedAt'>>;
export type ParticipantPatch = Partial<Pick<LessonParticipantRow, 'attendance' | 'absenceReason'>>;

/** Persistence for lessons, participants and the immutable lesson history. No business rules here. */
@Injectable()
export class LessonRepository {
  constructor(private readonly txm: TransactionManager) {}

  async insert(data: NewLesson): Promise<LessonRow> {
    const rows = await this.txm.db
      .insert(lesson)
      .values({ ...data, id: newId() })
      .returning();
    return rows[0]!;
  }

  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<LessonRow | null> {
    const query = this.txm.db.select().from(lesson).where(eq(lesson.id, id)).limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async findByIds(ids: readonly string[]): Promise<LessonRow[]> {
    if (ids.length === 0) return [];
    return this.txm.db
      .select()
      .from(lesson)
      .where(inArray(lesson.id, [...ids]));
  }

  /** Locks the given lessons in id order (deterministic, so two bulk operations cannot deadlock). */
  async lockByIds(ids: readonly string[]): Promise<LessonRow[]> {
    if (ids.length === 0) return [];
    return this.txm.db
      .select()
      .from(lesson)
      .where(inArray(lesson.id, [...ids]))
      .orderBy(asc(lesson.id))
      .for('update');
  }

  /** `bumpVersion` marks a change students must learn about (time, participants, status; NTF-08 keys). */
  async update(id: string, patch: LessonPatch, options: { bumpVersion?: boolean } = {}): Promise<LessonRow> {
    const rows = await this.txm.db
      .update(lesson)
      .set({ ...patch, ...(options.bumpVersion ? { version: sql`${lesson.version} + 1` } : {}) })
      .where(eq(lesson.id, id))
      .returning();
    const row = rows[0];
    if (!row) throw new Error(`lesson ${id} not found`);
    return row;
  }

  /** Lessons of a teacher intersecting the range (any status unless given), in start order. */
  async listByTeacher(
    teacherId: string,
    range: Interval,
    statuses?: readonly LessonStatus[],
  ): Promise<LessonRow[]> {
    return this.txm.db
      .select()
      .from(lesson)
      .where(
        and(
          eq(lesson.teacherId, teacherId),
          lt(lesson.startsAt, range.end),
          gt(lesson.endsAt, range.start),
          statuses ? inArray(lesson.status, [...statuses]) : undefined,
        ),
      )
      .orderBy(asc(lesson.startsAt), asc(lesson.id));
  }

  /** Lessons a student takes part in (not removed) within the range, across all teachers. */
  async listByStudent(
    studentId: string,
    range: Interval,
    statuses?: readonly LessonStatus[],
  ): Promise<LessonRow[]> {
    const mine = this.txm.db
      .select({ lessonId: lessonParticipant.lessonId })
      .from(lessonParticipant)
      .where(and(eq(lessonParticipant.studentId, studentId), isNull(lessonParticipant.removedAt)));
    return this.txm.db
      .select()
      .from(lesson)
      .where(
        and(
          inArray(lesson.id, mine),
          lt(lesson.startsAt, range.end),
          gt(lesson.endsAt, range.start),
          statuses ? inArray(lesson.status, [...statuses]) : undefined,
        ),
      )
      .orderBy(asc(lesson.startsAt), asc(lesson.id));
  }

  /** Scheduled lessons of a group starting after `from`, locked (membership changes apply to these). */
  async lockFutureByGroup(groupId: string, from: Date): Promise<LessonRow[]> {
    return this.txm.db
      .select()
      .from(lesson)
      .where(and(eq(lesson.groupId, groupId), eq(lesson.status, 'scheduled'), gt(lesson.startsAt, from)))
      .orderBy(asc(lesson.startsAt), asc(lesson.id))
      .for('update');
  }

  /** LES-01 sweep: scheduled lessons already over, locked for this run. */
  async lockScheduledEndedBefore(now: Date, limit: number): Promise<LessonRow[]> {
    return this.txm.db
      .select()
      .from(lesson)
      .where(and(eq(lesson.status, 'scheduled'), lte(lesson.endsAt, now)))
      .orderBy(asc(lesson.endsAt), asc(lesson.id))
      .limit(limit)
      .for('update', { skipLocked: true });
  }

  async listAwaitingReport(teacherId: string): Promise<LessonRow[]> {
    return this.txm.db
      .select()
      .from(lesson)
      .where(and(eq(lesson.teacherId, teacherId), eq(lesson.status, 'awaiting_report')))
      .orderBy(desc(lesson.endsAt), asc(lesson.id));
  }

  /** Who the teacher scheduled with most recently (5.6.3 "последние сверху"): newest lessons first. */
  async recentTargets(
    teacherId: string,
    limit = 30,
  ): Promise<Array<{ studentId: string | null; groupId: string | null }>> {
    return this.txm.db
      .select({
        groupId: lesson.groupId,
        studentId: sql<string | null>`(SELECT p.student_id FROM lesson_participant p
          WHERE p.lesson_id = ${lesson.id} AND ${lesson.groupId} IS NULL AND p.removed_at IS NULL LIMIT 1)`,
      })
      .from(lesson)
      .where(eq(lesson.teacherId, teacherId))
      .orderBy(desc(lesson.createdAt))
      .limit(limit);
  }

  /** Next "Занятие №N" for an individual lesson of the pair; the caller holds the link row lock. */
  async nextSeq(linkId: string): Promise<number> {
    const rows = await this.txm.db
      .update(teacherStudent)
      .set({ lessonSeq: sql`${teacherStudent.lessonSeq} + 1` })
      .where(eq(teacherStudent.id, linkId))
      .returning({ seq: teacherStudent.lessonSeq });
    const seq = rows[0]?.seq;
    if (seq === undefined) throw new Error(`teacher_student ${linkId} not found`);
    return seq;
  }

  // --- participants ---------------------------------------------------------------------------

  /** Idempotent: a student already in the lesson is skipped (`lesson_participant_active_uniq`). */
  async addParticipants(
    lessonId: string,
    studentIds: readonly string[],
    addedAt: Date,
  ): Promise<LessonParticipantRow[]> {
    if (studentIds.length === 0) return [];
    return this.txm.db
      .insert(lessonParticipant)
      .values(studentIds.map((studentId) => ({ id: newId(), lessonId, studentId, addedAt })))
      .onConflictDoNothing()
      .returning();
  }

  async listParticipants(lessonId: string): Promise<LessonParticipantRow[]> {
    return this.txm.db
      .select()
      .from(lessonParticipant)
      .where(and(eq(lessonParticipant.lessonId, lessonId), isNull(lessonParticipant.removedAt)))
      .orderBy(asc(lessonParticipant.addedAt), asc(lessonParticipant.id));
  }

  async listParticipantsOf(lessonIds: readonly string[]): Promise<Map<string, LessonParticipantRow[]>> {
    const out = new Map<string, LessonParticipantRow[]>();
    if (lessonIds.length === 0) return out;
    const rows = await this.txm.db
      .select()
      .from(lessonParticipant)
      .where(and(inArray(lessonParticipant.lessonId, [...lessonIds]), isNull(lessonParticipant.removedAt)))
      .orderBy(asc(lessonParticipant.addedAt), asc(lessonParticipant.id));
    for (const r of rows) out.set(r.lessonId, [...(out.get(r.lessonId) ?? []), r]);
    return out;
  }

  async removeParticipant(
    lessonId: string,
    studentId: string,
    removedAt: Date,
  ): Promise<LessonParticipantRow | null> {
    const rows = await this.txm.db
      .update(lessonParticipant)
      .set({ removedAt })
      .where(
        and(
          eq(lessonParticipant.lessonId, lessonId),
          eq(lessonParticipant.studentId, studentId),
          isNull(lessonParticipant.removedAt),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  async updateParticipant(id: string, patch: ParticipantPatch): Promise<LessonParticipantRow> {
    const rows = await this.txm.db
      .update(lessonParticipant)
      .set(patch)
      .where(eq(lessonParticipant.id, id))
      .returning();
    const row = rows[0];
    if (!row) throw new Error(`lesson_participant ${id} not found`);
    return row;
  }

  // --- history (LES-05) -----------------------------------------------------------------------

  async addEvent(data: {
    lessonId: string;
    type: string;
    actorId: string | null;
    payload?: Record<string, unknown>;
    at: Date;
  }): Promise<LessonEventRow> {
    const rows = await this.txm.db
      .insert(lessonEvent)
      .values({
        id: newId(),
        lessonId: data.lessonId,
        type: data.type,
        actorId: data.actorId,
        payload: data.payload ?? {},
        at: data.at,
      })
      .returning();
    return rows[0]!;
  }

  async listEvents(lessonId: string): Promise<LessonEventRow[]> {
    return this.txm.db
      .select()
      .from(lessonEvent)
      .where(eq(lessonEvent.lessonId, lessonId))
      .orderBy(asc(lessonEvent.at), asc(lessonEvent.id));
  }
}
