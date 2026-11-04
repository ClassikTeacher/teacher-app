import { DateTime } from 'luxon';
import { AppError } from '@shared/errors/app-error.js';
import { localInstant } from '../availability/windows.js';
import type { Interval } from '../schema.js';

/**
 * The subset of RFC 5545 RRULE the platform stores (7.5 "Серии"): `FREQ=WEEKLY;INTERVAL=n;BYDAY=MO,TU,…`.
 * Expansion is done here with Luxon in the teacher's zone; the end is `lesson_series.ends_on`, not UNTIL.
 */
export interface WeeklyRecurrence {
  intervalWeeks: number;
  /** ISO weekdays 1 = Monday … 7 = Sunday, sorted. */
  weekdays: number[];
}

const BYDAY = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export const MAX_INTERVAL_WEEKS = 8;

export function formatRRule(rule: WeeklyRecurrence): string {
  const days = [...new Set(rule.weekdays)].sort((a, b) => a - b).map((d) => BYDAY[d - 1]);
  const interval = rule.intervalWeeks > 1 ? `;INTERVAL=${rule.intervalWeeks}` : '';
  return `FREQ=WEEKLY${interval};BYDAY=${days.join(',')}`;
}

export function parseRRule(value: string): WeeklyRecurrence {
  const parts = new Map(value.split(';').map((p) => p.split('=') as [string, string]));
  if (parts.get('FREQ') !== 'WEEKLY')
    throw AppError.validation('Only weekly series are supported', { rrule: value });
  const interval = parts.has('INTERVAL') ? Number(parts.get('INTERVAL')) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > MAX_INTERVAL_WEEKS)
    throw AppError.validation('INTERVAL is out of range', { max: MAX_INTERVAL_WEEKS });
  const weekdays = (parts.get('BYDAY') ?? '')
    .split(',')
    .filter(Boolean)
    .map((d) => BYDAY.indexOf(d as (typeof BYDAY)[number]) + 1);
  if (weekdays.length === 0 || weekdays.some((d) => d === 0))
    throw AppError.validation('BYDAY must list weekdays', { rrule: value });
  return { intervalWeeks: interval, weekdays: [...new Set(weekdays)].sort((a, b) => a - b) };
}

export interface ExpandInput {
  rrule: string;
  zone: string;
  /** Minutes since local midnight. */
  startMin: number;
  durationMin: number;
  /** ISO dates in the zone; the series counts its weeks from the Monday of `startsOn`. */
  startsOn: string;
  endsOn: string | null;
  /** Expansion window as ISO dates, inclusive. */
  fromDate: string;
  toDate: string;
  pausedFrom?: string | null;
  pausedTo?: string | null;
}

export interface Occurrence {
  dateIso: string;
  during: Interval;
}

/**
 * Occurrences between `fromDate` and `toDate` (inclusive, both clamped by the series bounds), as UTC intervals.
 * Wall-clock start is kept on every date, so a 16:00 lesson stays at 16:00 across a DST change (CAL-05); a start
 * inside a spring-forward gap moves to the first valid minute, the duration is kept.
 */
export function expandSeries(input: ExpandInput): Occurrence[] {
  const rule = parseRRule(input.rrule);
  const anchor = DateTime.fromISO(input.startsOn, { zone: input.zone }).startOf('week');
  let from = DateTime.fromISO(input.fromDate, { zone: input.zone }).startOf('day');
  const startsOn = DateTime.fromISO(input.startsOn, { zone: input.zone }).startOf('day');
  if (from < startsOn) from = startsOn;
  let to = DateTime.fromISO(input.toDate, { zone: input.zone }).startOf('day');
  if (input.endsOn) {
    const endsOn = DateTime.fromISO(input.endsOn, { zone: input.zone }).startOf('day');
    if (endsOn < to) to = endsOn;
  }
  if (!anchor.isValid || !from.isValid || !to.isValid) throw AppError.validation('Invalid series dates');
  const out: Occurrence[] = [];
  for (let day = from; day <= to; day = day.plus({ days: 1 })) {
    if (!rule.weekdays.includes(day.weekday)) continue;
    if (!isOnPhase(day, anchor, rule.intervalWeeks)) continue;
    const iso = day.toISODate();
    if (input.pausedFrom && input.pausedTo && iso >= input.pausedFrom && iso <= input.pausedTo) continue;
    const start = localInstant(day, input.startMin);
    out.push({
      dateIso: iso,
      during: { start, end: new Date(start.getTime() + input.durationMin * 60_000) },
    });
  }
  return out;
}

/** Whole weeks between the Monday of `day` and the anchor Monday; INTERVAL counts from the anchor week. */
export function isOnPhase(day: DateTime, anchor: DateTime, intervalWeeks: number): boolean {
  const weeks = Math.round(day.startOf('week').diff(anchor, 'days').days / 7);
  return ((weeks % intervalWeeks) + intervalWeeks) % intervalWeeks === 0;
}

/** First date on or after `fromDate` whose week is on phase with the series anchored at `startsOn`. */
export function phaseAlignedStart(
  startsOn: string,
  intervalWeeks: number,
  fromDate: string,
  zone: string,
): string {
  const anchor = DateTime.fromISO(startsOn, { zone }).startOf('week');
  let day = DateTime.fromISO(fromDate, { zone }).startOf('day');
  if (isOnPhase(day, anchor, intervalWeeks)) return day.toISODate()!;
  day = day.startOf('week');
  while (!isOnPhase(day, anchor, intervalWeeks)) day = day.plus({ weeks: 1 });
  return day.toISODate()!;
}
