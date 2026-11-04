import { Injectable } from '@nestjs/common';
import { AppError } from '@shared/errors/app-error.js';
import { Clock, DAY_MS, HOUR_MS } from '@shared/time/clock.js';
import { type Actor, assertActive } from '@modules/access/actor.js';
import { FeatureService } from '@modules/access/features/feature.service.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import type { BookingRules, TeacherProfileRow, TeacherStudentRow } from '@modules/people/schema.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { WindowsPolicy } from '../lessons/windows.policy.js';
import { BusyQuery } from '../occupancy/busy.query.js';
import { BookingRequestRepository } from '../requests/booking-request.repository.js';
import type { Interval } from '../schema.js';
import { computeOpenSlots } from './slots.js';

/** 5.5.5 defaults (💡 values of the spec) when the teacher has not set booking rules. */
export const DEFAULT_BOOKING_RULES: Required<BookingRules> = {
  minNoticeHours: 12,
  horizonDays: 21,
  durations: [],
  gridStepMin: 30,
  maxPendingPerSlot: 2,
};
export const MAX_SLOTS_RANGE_DAYS = 31;

export interface OpenSlotsInput {
  teacherId: string;
  /** Required for a student actor (their own id); optional for the teacher (their student). */
  studentId?: string;
  range: Interval;
  durationMin?: number;
  /** The lesson being moved: its own occupancy does not block the slots (5.7.4, M-2). */
  excludeLessonId?: string;
}

export interface OpenSlotsResult {
  durationMin: number;
  durations: number[];
  gridStepMin: number;
  slots: Interval[];
}

/** The teacher's calendar is open for this student when the mode says so and the card does not override it. */
export function isCalendarOpenFor(profile: TeacherProfileRow, link: TeacherStudentRow): boolean {
  if (profile.calendarMode === 'closed') return false; // "закрыт" wins over any card override
  if (link.calendarOpen !== null) return link.calendarOpen;
  return profile.calendarMode === 'open_all';
}

/**
 * `GET /availability/slots` (5.5.4 "Открытые слоты", CAL-08): windows − teacher busy − student busy, within the
 * horizon and after the minimum notice. A student sees slots only when the teacher's calendar is open for them
 * (5.5.3); the teacher sees them for any active student. Pending requests (5.5.5 "N заявок") arrive with M4.
 */
@Injectable()
export class OpenSlotsQuery {
  constructor(
    private readonly profiles: TeacherProfileRepository,
    private readonly links: TeacherStudentRepository,
    private readonly accounts: AccountRepository,
    private readonly windows: WindowsPolicy,
    private readonly busy: BusyQuery,
    private readonly features: FeatureService,
    private readonly requests: BookingRequestRepository,
    private readonly clock: Clock,
  ) {}

  async slots(actor: Actor, input: OpenSlotsInput): Promise<OpenSlotsResult> {
    assertActive(actor);
    if (input.range.end.getTime() <= input.range.start.getTime())
      throw AppError.validation('`to` must be after `from`');
    if (input.range.end.getTime() - input.range.start.getTime() > MAX_SLOTS_RANGE_DAYS * DAY_MS)
      throw AppError.validation('Range is too long', { maxDays: MAX_SLOTS_RANGE_DAYS });
    const { profile, link } = await this.authorize(actor, input);
    const rules = { ...DEFAULT_BOOKING_RULES, ...profile.bookingRules };
    const durations = rules.durations.length > 0 ? rules.durations : [profile.defaultDurationMin];
    const durationMin = input.durationMin ?? durations[0]!;
    if (!durations.includes(durationMin))
      throw AppError.validation('Duration is not offered by the teacher', { durations });
    const now = this.clock.now();
    const range: Interval = {
      start: new Date(Math.max(input.range.start.getTime(), now.getTime() + rules.minNoticeHours * HOUR_MS)),
      end: new Date(Math.min(input.range.end.getTime(), now.getTime() + rules.horizonDays * DAY_MS)),
    };
    const empty = { durationMin, durations, gridStepMin: rules.gridStepMin, slots: [] };
    if (range.end.getTime() <= range.start.getTime()) return empty;
    const teacher = await this.accounts.findById(input.teacherId);
    const zone = teacher?.timezone ?? 'UTC';
    const windows = await this.windows.windowsOf(input.teacherId, range, zone);
    if (!windows || windows.length === 0) return empty;
    const studentId = link?.studentId ?? null;
    const busy = await this.busy.busyOf(
      studentId ? [input.teacherId, studentId] : [input.teacherId],
      { start: new Date(range.start.getTime() - DAY_MS), end: new Date(range.end.getTime() + DAY_MS) },
      input.excludeLessonId,
    );
    const slots = computeOpenSlots({
      windows,
      teacherBusy: busy.get(input.teacherId) ?? [],
      bufferBeforeMin: profile.bufferBeforeMin,
      bufferAfterMin: profile.bufferAfterMin,
      studentBusy: studentId ? (busy.get(studentId) ?? []) : [],
      gridStepMin: rules.gridStepMin,
      durationMin,
      range,
      zone,
    });
    // 5.5.5 «не больше N заявок»: in the confirmation mode a slot with N pending requests is not offered (M-5)
    if (profile.bookingConfirmation === 'manual') {
      const pending = await this.requests.listPendingBookingsIn(input.teacherId, range);
      if (pending.length > 0) {
        const full = slots.filter(
          (slot) =>
            pending.filter((r) => r.startsAt! < slot.end && r.endsAt! > slot.start).length >=
            rules.maxPendingPerSlot,
        );
        return { ...empty, slots: slots.filter((s) => !full.includes(s)) };
      }
    }
    return { ...empty, slots };
  }

  private async authorize(
    actor: Actor,
    input: OpenSlotsInput,
  ): Promise<{ profile: TeacherProfileRow; link: TeacherStudentRow | null }> {
    const profile = await this.profiles.find(input.teacherId);
    if (!profile) throw AppError.notFound('teacher', input.teacherId);
    // ACC-04: a blocked teacher's calendar is closed to everyone (H-2)
    if ((await this.accounts.findById(input.teacherId))?.status === 'blocked')
      throw AppError.notFound('teacher', input.teacherId);
    if (actor.accountId === input.teacherId && actor.roles.includes('TEACHER')) {
      if (!input.studentId) return { profile, link: null };
      const link = await this.links.findByPair(input.teacherId, input.studentId);
      if (link?.status !== 'active') throw AppError.notFound('student', input.studentId);
      return { profile, link };
    }
    if (actor.roles.includes('STUDENT') && (input.studentId ?? actor.accountId) === actor.accountId) {
      const link = await this.links.findByPair(input.teacherId, actor.accountId);
      if (link?.status !== 'active') throw AppError.notFound('teacher', input.teacherId);
      await this.features.assertEnabled(input.teacherId, 'calendar.open_booking'); // 5.5.5 is a feature
      if (!isCalendarOpenFor(profile, link))
        throw AppError.forbidden('The teacher has not opened the calendar for you', {
          reason: 'calendar_closed',
        });
      return { profile, link };
    }
    throw AppError.notFound('teacher', input.teacherId);
  }
}
