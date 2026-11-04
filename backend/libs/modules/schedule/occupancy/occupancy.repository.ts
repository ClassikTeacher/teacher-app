import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import { type Interval, occupancy, type OccupancyKind, type OccupancyRow } from '../schema.js';

export interface NewOccupancy {
  accountId: string;
  kind: OccupancyKind;
  lessonId?: string | null;
  blockId?: string | null;
  during: Interval;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
}

export interface BusyRow {
  accountId: string;
  during: Interval;
}

/** Persistence for occupancy rows (7.5). The EXCLUDE constraint is the real guard; callers map 23P01. */
@Injectable()
export class OccupancyRepository {
  constructor(private readonly txm: TransactionManager) {}

  /** Throws the raw exclusion violation (23P01, `occupancy_no_overlap`) when a row overlaps an active one. */
  async insertMany(rows: readonly NewOccupancy[]): Promise<OccupancyRow[]> {
    if (rows.length === 0) return [];
    return this.txm.db
      .insert(occupancy)
      .values(
        rows.map((r) => ({
          id: newId(),
          accountId: r.accountId,
          kind: r.kind,
          lessonId: r.lessonId ?? null,
          blockId: r.blockId ?? null,
          during: r.during,
          bufferBeforeMin: r.bufferBeforeMin ?? 0,
          bufferAfterMin: r.bufferAfterMin ?? 0,
        })),
      )
      .returning();
  }

  /** Active rows of these accounts intersecting `[start, end)`; the pre-check behind CAL-06. */
  async findActiveOverlaps(accountIds: readonly string[], during: Interval): Promise<OccupancyRow[]> {
    if (accountIds.length === 0) return [];
    return this.txm.db
      .select()
      .from(occupancy)
      .where(
        and(
          inArray(occupancy.accountId, [...accountIds]),
          eq(occupancy.isActive, true),
          sql`${occupancy.during} && tstzrange(${during.start.toISOString()}::timestamptz, ${during.end.toISOString()}::timestamptz, '[)')`,
        ),
      );
  }

  /** Busy intervals of accounts within a range, with no source details (CAL-07). */
  async listBusy(
    accountIds: readonly string[],
    range: Interval,
    excludeLessonId?: string,
  ): Promise<BusyRow[]> {
    if (accountIds.length === 0) return [];
    const rows = await this.txm.db
      .select({ accountId: occupancy.accountId, during: occupancy.during })
      .from(occupancy)
      .where(
        and(
          inArray(occupancy.accountId, [...accountIds]),
          eq(occupancy.isActive, true),
          excludeLessonId ? sql`${occupancy.lessonId} IS DISTINCT FROM ${excludeLessonId}::uuid` : undefined,
          sql`${occupancy.during} && tstzrange(${range.start.toISOString()}::timestamptz, ${range.end.toISOString()}::timestamptz, '[)')`,
        ),
      )
      .orderBy(sql`lower(${occupancy.during})`);
    return rows;
  }

  async listByLesson(lessonId: string): Promise<OccupancyRow[]> {
    return this.txm.db
      .select()
      .from(occupancy)
      .where(and(eq(occupancy.lessonId, lessonId), eq(occupancy.isActive, true)));
  }

  /** Releases the active rows of a lesson (all, or one participant); returns how many were released. */
  async deactivateByLesson(lessonId: string, accountId?: string): Promise<number> {
    const rows = await this.txm.db
      .update(occupancy)
      .set({ isActive: false })
      .where(
        and(
          eq(occupancy.lessonId, lessonId),
          eq(occupancy.isActive, true),
          accountId ? eq(occupancy.accountId, accountId) : undefined,
        ),
      )
      .returning({ id: occupancy.id });
    return rows.length;
  }

  async deactivateByBlock(blockId: string): Promise<number> {
    const rows = await this.txm.db
      .update(occupancy)
      .set({ isActive: false })
      .where(and(eq(occupancy.blockId, blockId), eq(occupancy.isActive, true)))
      .returning({ id: occupancy.id });
    return rows.length;
  }
}
