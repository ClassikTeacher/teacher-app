import { Injectable } from '@nestjs/common';
import { AppError } from '@shared/errors/app-error.js';
import { DAY_MS } from '@shared/time/clock.js';
import { type Actor, assertActive, isAdmin } from '@modules/access/actor.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import type { Interval } from '../schema.js';
import { isValidInterval, mergeIntervals } from './intervals.js';
import { OccupancyRepository } from './occupancy.repository.js';

/** Longest range one busy query may cover. */
export const MAX_BUSY_RANGE_DAYS = 62;

/**
 * `GET /calendar/busy` (CAL-07): only time intervals, never titles, subjects or people. Visibility (5.5.3):
 * everyone sees their own busy time; a teacher sees their active students'; an admin sees everyone's.
 */
@Injectable()
export class BusyQuery {
  constructor(
    private readonly occupancy: OccupancyRepository,
    private readonly links: TeacherStudentRepository,
  ) {}

  async busy(actor: Actor, accountId: string, range: Interval): Promise<Interval[]> {
    assertActive(actor);
    if (!isValidInterval(range)) throw AppError.validation('`to` must be after `from`');
    if (range.end.getTime() - range.start.getTime() > MAX_BUSY_RANGE_DAYS * DAY_MS)
      throw AppError.validation('Range is too long', { maxDays: MAX_BUSY_RANGE_DAYS });
    if (!(await this.canSee(actor, accountId))) throw AppError.notFound('account', accountId);
    const rows = await this.occupancy.listBusy([accountId], range);
    return mergeIntervals(rows.map((r) => r.during));
  }

  /** Busy time of several accounts at once (slot calculation); the caller has already checked visibility. */
  async busyOf(
    accountIds: readonly string[],
    range: Interval,
    excludeLessonId?: string,
  ): Promise<Map<string, Interval[]>> {
    const rows = await this.occupancy.listBusy(accountIds, range, excludeLessonId);
    const byAccount = new Map<string, Interval[]>();
    for (const r of rows) byAccount.set(r.accountId, [...(byAccount.get(r.accountId) ?? []), r.during]);
    return new Map([...byAccount].map(([id, list]) => [id, mergeIntervals(list)]));
  }

  private async canSee(actor: Actor, accountId: string): Promise<boolean> {
    if (actor.accountId === accountId || isAdmin(actor)) return true;
    if (!actor.roles.includes('TEACHER')) return false;
    const link = await this.links.findByPair(actor.accountId, accountId);
    return link?.status === 'active';
  }
}
