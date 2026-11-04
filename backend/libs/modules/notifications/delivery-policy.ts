import { DateTime } from 'luxon';
import { AppError } from '@shared/errors/app-error.js';
import type { NotificationProfileRow } from './schema.js';
import { NOTIFICATION_TYPES, type NotificationTypeCode } from './types.js';

/** 5.13.3: the intervals a person may pick (minutes before the lesson), at most three. */
export const REMINDER_OFFSET_OPTIONS = [15, 30, 60, 120, 180, 1440] as const;
export const MAX_REMINDER_OFFSETS = 3;
/** NTF-02 / NTF-06: cancellations and moves count as critical only this close to the lesson. */
export const CRITICAL_HORIZON_MS = 48 * 60 * 60 * 1000;
export const QUIET_CRITICAL_HORIZON_MS = 12 * 60 * 60 * 1000;
/** Types whose urgency depends on how soon the lesson is (critical within the horizon, muteable otherwise). */
export const TIME_SENSITIVE_TYPES: ReadonlySet<string> = new Set([
  'lesson.cancelled',
  'lesson.rescheduled',
  'cancellation.bulk',
]);

/** Validates a chosen set of reminder offsets; an empty list switches reminders off. */
export function normalizeOffsets(raw: readonly number[]): number[] {
  const unique = [...new Set(raw)].sort((a, b) => b - a);
  if (unique.length > MAX_REMINDER_OFFSETS)
    throw AppError.validation('Too many reminder intervals', { max: MAX_REMINDER_OFFSETS });
  if (unique.some((o) => !(REMINDER_OFFSET_OPTIONS as readonly number[]).includes(o)))
    throw AppError.validation('Unknown reminder interval', { options: REMINDER_OFFSET_OPTIONS });
  return unique;
}

/** `HH:MM` or `HH:MM:SS` → minutes since midnight. */
export function timeToMinutes(value: string): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!m) throw AppError.validation('Time must be HH:MM');
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw AppError.validation('Time must be HH:MM');
  return h * 60 + min;
}

/**
 * Effective urgency of one message: the registry's flag, narrowed for time-sensitive types to «the lesson is
 * within `horizon`» (NTF-02: a cancellation of a lesson next month may wait and may be muted by a parent).
 */
export function isCritical(
  type: NotificationTypeCode,
  lessonStartsAt: Date | null,
  now: Date,
  horizonMs = CRITICAL_HORIZON_MS,
): boolean {
  const flag = NOTIFICATION_TYPES[type].critical;
  if (!flag) return false;
  if (!TIME_SENSITIVE_TYPES.has(type)) return true;
  return lessonStartsAt !== null && lessonStartsAt.getTime() - now.getTime() < horizonMs;
}

/**
 * NTF-06: a non-critical message due inside the recipient's quiet hours waits until they end (the next
 * morning in the recipient's zone). Reminders keep their time: a reminder after the lesson is useless.
 */
export function deferForQuietHours(
  dueAt: Date,
  profile: Pick<NotificationProfileRow, 'quietEnabled' | 'quietFrom' | 'quietTo'>,
  zone: string,
): Date {
  if (!profile.quietEnabled) return dueAt;
  const from = timeToMinutes(profile.quietFrom);
  const to = timeToMinutes(profile.quietTo);
  if (from === to) return dueAt;
  const local = DateTime.fromJSDate(dueAt, { zone });
  const minutes = local.hour * 60 + local.minute;
  const wraps = from > to; // 22:00 → 08:00
  const inside = wraps ? minutes >= from || minutes < to : minutes >= from && minutes < to;
  if (!inside) return dueAt;
  const endToday = local.set({ hour: Math.floor(to / 60), minute: to % 60, second: 0, millisecond: 0 });
  const end = wraps && minutes >= from ? endToday.plus({ days: 1 }) : endToday;
  return end.toJSDate();
}
