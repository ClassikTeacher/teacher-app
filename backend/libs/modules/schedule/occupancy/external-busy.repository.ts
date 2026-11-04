import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import { externalBusy, type ExternalBusySource, type Interval } from '../schema.js';
import type { BusyRow } from './occupancy.repository.js';
import { isValidInterval, mergeIntervals } from './intervals.js';

/**
 * Busy time imported from external calendars (5.5.2 «Событие из Google Calendar», 8.2 `external_busy`). A soft
 * block: it is subtracted from the open slots and shown to students as busy, but never stops the teacher
 * (no EXCLUDE here). An integration replaces the rows of its source as a whole on every sync.
 */
@Injectable()
export class ExternalBusyRepository {
  constructor(private readonly txm: TransactionManager) {}

  /** Replaces the intervals of one source for an account; merged first, so one row per busy stretch. */
  async replace(
    accountId: string,
    source: ExternalBusySource,
    intervals: readonly Interval[],
    syncedAt: Date,
  ): Promise<number> {
    const merged = mergeIntervals(intervals.filter(isValidInterval));
    await this.clear(accountId, source);
    if (merged.length === 0) return 0;
    await this.txm.db
      .insert(externalBusy)
      .values(merged.map((during) => ({ id: newId(), accountId, source, during, syncedAt })));
    return merged.length;
  }

  async clear(accountId: string, source: ExternalBusySource): Promise<void> {
    await this.txm.db
      .delete(externalBusy)
      .where(and(eq(externalBusy.accountId, accountId), eq(externalBusy.source, source)));
  }

  /** Busy intervals of accounts within a range, in the same shape as occupancy rows (CAL-07: no details). */
  async listBusy(accountIds: readonly string[], range: Interval): Promise<BusyRow[]> {
    if (accountIds.length === 0) return [];
    return this.txm.db
      .select({ accountId: externalBusy.accountId, during: externalBusy.during })
      .from(externalBusy)
      .where(
        and(
          inArray(externalBusy.accountId, [...accountIds]),
          sql`${externalBusy.during} && tstzrange(${range.start.toISOString()}::timestamptz, ${range.end.toISOString()}::timestamptz, '[)')`,
        ),
      )
      .orderBy(sql`lower(${externalBusy.during})`);
  }

  /** The external intervals of one account overlapping `during` (the teacher's warning, 5.5.2). */
  async overlapping(accountId: string, during: Interval): Promise<Interval[]> {
    return (await this.listBusy([accountId], during)).map((r) => r.during);
  }
}
