import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { AvailabilityRepository } from '../availability/availability.repository.js';
import { computeWindows, isInsideWindows, timeToMinutes } from '../availability/windows.js';
import type { Interval } from '../schema.js';

/**
 * CAL-09: windows never block a teacher, they only mark a lesson "вне окна". A teacher without any rules has
 * no windows at all, so nothing is marked for them (the mark would be noise).
 */
@Injectable()
export class WindowsPolicy {
  constructor(
    private readonly availability: AvailabilityRepository,
    private readonly accounts: AccountRepository,
  ) {}

  /** Windows as UTC intervals within the range, or null when the teacher has neither rules nor exceptions. */
  async windowsOf(teacherId: string, range: Interval, knownZone?: string): Promise<Interval[] | null> {
    const zone = knownZone ?? (await this.accounts.findById(teacherId))?.timezone ?? 'UTC';
    const from = DateTime.fromJSDate(range.start, { zone }).startOf('day');
    const to = DateTime.fromJSDate(range.end, { zone }).startOf('day');
    const [rules, exceptions] = await Promise.all([
      this.availability.listRules(teacherId),
      this.availability.listExceptions(teacherId, from.toISODate()!, to.toISODate()!),
    ]);
    if (rules.length === 0 && exceptions.every((e) => e.kind !== 'extra')) return null;
    return computeWindows({
      zone,
      range,
      rules: rules.map((r) => ({
        weekday: r.weekday,
        startMin: timeToMinutes(r.startLocal),
        endMin: timeToMinutes(r.endLocal),
        validFrom: r.validFrom,
        validTo: r.validTo,
      })),
      exceptions: exceptions.map((e) => ({
        date: e.date,
        kind: e.kind,
        startMin: e.startLocal ? timeToMinutes(e.startLocal) : null,
        endMin: e.endLocal ? timeToMinutes(e.endLocal) : null,
      })),
    });
  }

  /** True only for a teacher who has windows at all and placed the lesson outside them. */
  async isOutsideWindows(teacherId: string, during: Interval): Promise<boolean> {
    const windows = await this.windowsOf(teacherId, during);
    return windows !== null && !isInsideWindows(windows, during);
  }
}
