import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import {
  lesson,
  type LessonRow,
  lessonSeries,
  type LessonSeriesInsert,
  type LessonSeriesRow,
} from '../schema.js';

export type NewSeries = Omit<LessonSeriesInsert, 'id' | 'createdAt' | 'updatedAt'>;
export type SeriesPatch = Partial<Omit<LessonSeriesInsert, 'id' | 'teacherId' | 'createdAt' | 'updatedAt'>>;

/** Persistence for regular lessons (5.5.6). No business rules here. */
@Injectable()
export class SeriesRepository {
  constructor(private readonly txm: TransactionManager) {}

  async insert(data: NewSeries): Promise<LessonSeriesRow> {
    const rows = await this.txm.db
      .insert(lessonSeries)
      .values({ ...data, id: newId() })
      .returning();
    return rows[0]!;
  }

  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<LessonSeriesRow | null> {
    const query = this.txm.db.select().from(lessonSeries).where(eq(lessonSeries.id, id)).limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async update(id: string, patch: SeriesPatch): Promise<LessonSeriesRow> {
    const rows = await this.txm.db.update(lessonSeries).set(patch).where(eq(lessonSeries.id, id)).returning();
    const row = rows[0];
    if (!row) throw new Error(`lesson_series ${id} not found`);
    return row;
  }

  async listActiveByTeacher(teacherId: string): Promise<LessonSeriesRow[]> {
    return this.txm.db
      .select()
      .from(lessonSeries)
      .where(and(eq(lessonSeries.teacherId, teacherId), eq(lessonSeries.status, 'active')))
      .orderBy(asc(lessonSeries.startLocal), asc(lessonSeries.id));
  }

  /** Active series of a student (individual ones) — ended when the student is blocked (H-1). */
  async listActiveByStudent(studentId: string): Promise<LessonSeriesRow[]> {
    return this.txm.db
      .select()
      .from(lessonSeries)
      .where(and(eq(lessonSeries.studentId, studentId), eq(lessonSeries.status, 'active')))
      .orderBy(asc(lessonSeries.id));
  }

  /**
   * Active series whose materialised horizon ends before `untilDate` (ISO), locked for this worker pass
   * (`FOR UPDATE SKIP LOCKED`), so two workers never expand the same series at once.
   */
  async lockDueForMaterialization(untilDate: string, limit: number): Promise<LessonSeriesRow[]> {
    return this.txm.db
      .select()
      .from(lessonSeries)
      .where(
        and(
          eq(lessonSeries.status, 'active'),
          or(isNull(lessonSeries.materializedUntil), lt(lessonSeries.materializedUntil, untilDate)),
          or(
            isNull(lessonSeries.endsOn),
            sql`${lessonSeries.endsOn} >= coalesce(${lessonSeries.materializedUntil}, ${lessonSeries.startsOn})`,
          ),
        ),
      )
      .orderBy(asc(lessonSeries.materializedUntil), asc(lessonSeries.id))
      .limit(limit)
      .for('update', { skipLocked: true });
  }

  /** Starts (epoch ms) of the live instances of a series: a re-run never creates a second one for a date. */
  async instanceStarts(seriesId: string): Promise<Set<number>> {
    const rows = await this.txm.db
      .select({ startsAt: lesson.startsAt })
      .from(lesson)
      .where(and(eq(lesson.seriesId, seriesId), sql`${lesson.status} <> 'cancelled'`));
    return new Set(rows.map((r) => r.startsAt.getTime()));
  }

  /** Scheduled instances starting at or after `from` (and before `to`), locked for a status change. */
  async lockScheduledInstances(seriesId: string, from: Date, to?: Date): Promise<LessonRow[]> {
    return this.txm.db
      .select()
      .from(lesson)
      .where(
        and(
          eq(lesson.seriesId, seriesId),
          eq(lesson.status, 'scheduled'),
          gte(lesson.startsAt, from),
          to ? lt(lesson.startsAt, to) : undefined,
        ),
      )
      .orderBy(asc(lesson.startsAt), asc(lesson.id))
      .for('update');
  }

  /** Ids of scheduled instances starting at or after `from` (for M4-06 cancellation contracts). */
  async scheduledInstanceIds(seriesId: string, from: Date, to?: Date): Promise<string[]> {
    const rows = await this.txm.db
      .select({ id: lesson.id })
      .from(lesson)
      .where(
        and(
          eq(lesson.seriesId, seriesId),
          eq(lesson.status, 'scheduled'),
          gt(lesson.startsAt, from),
          to ? lt(lesson.startsAt, to) : undefined,
        ),
      )
      .orderBy(asc(lesson.startsAt));
    return rows.map((r) => r.id);
  }

  async countInstances(seriesIds: readonly string[]): Promise<Map<string, number>> {
    if (seriesIds.length === 0) return new Map();
    const rows = await this.txm.db
      .select({ seriesId: lesson.seriesId, count: sql<number>`count(*)::int` })
      .from(lesson)
      .where(and(inArray(lesson.seriesId, [...seriesIds]), eq(lesson.status, 'scheduled')))
      .groupBy(lesson.seriesId);
    return new Map(rows.map((r) => [r.seriesId!, r.count]));
  }
}
