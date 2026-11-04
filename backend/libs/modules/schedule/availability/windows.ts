import { DateTime } from 'luxon';
import { mergeIntervals, subtractIntervals } from '../occupancy/intervals.js';
import type { Interval } from '../schema.js';

/** A weekly rule or an exception in the teacher's local time (5.5.4); times as minutes since midnight. */
export interface WeeklyRule {
  /** ISO weekday 1 = Monday … 7 = Sunday. */
  weekday: number;
  startMin: number;
  endMin: number;
  /** ISO dates `YYYY-MM-DD`; null = open-ended. */
  validFrom: string | null;
  validTo: string | null;
}

export interface DateException {
  date: string;
  kind: 'closed' | 'extra';
  /** null = the whole day (only for `closed`). */
  startMin: number | null;
  endMin: number | null;
}

export const MINUTES_PER_DAY = 24 * 60;

/** `HH:MM[:SS]` ⇄ minutes since midnight (SQL `time` columns). */
export function timeToMinutes(value: string): number {
  const [h = '0', m = '0'] = value.split(':');
  return Number(h) * 60 + Number(m);
}

export function minutesToTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;
}

/**
 * Wall-clock minutes of a local day → UTC instant. On a spring-forward day a time inside the gap moves to the
 * first valid instant after it; `MINUTES_PER_DAY` is the next midnight (so a 23- or 25-hour day keeps its end).
 */
export function localInstant(day: DateTime, minutes: number): Date {
  if (minutes >= MINUTES_PER_DAY) return day.plus({ days: 1 }).startOf('day').toJSDate();
  return day
    .set({ hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0, millisecond: 0 })
    .toJSDate();
}

function localSpan(day: DateTime, startMin: number, endMin: number): Interval | null {
  const start = localInstant(day, startMin);
  const end = localInstant(day, endMin);
  return end.getTime() > start.getTime() ? { start, end } : null;
}

/**
 * Availability windows (5.5.4) as UTC intervals for every local day touching `range`: weekly rules within their
 * validity, minus closed exceptions (whole day or interval), plus extra windows. Rules and exceptions are
 * interpreted in the teacher's zone, so DST transitions keep the wall-clock times (CAL-05).
 */
export function computeWindows(input: {
  rules: readonly WeeklyRule[];
  exceptions: readonly DateException[];
  zone: string;
  range: Interval;
}): Interval[] {
  const first = DateTime.fromJSDate(input.range.start, { zone: input.zone }).startOf('day');
  const last = DateTime.fromJSDate(input.range.end, { zone: input.zone }).startOf('day');
  const byDate = new Map<string, DateException[]>();
  for (const e of input.exceptions) byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
  const out: Interval[] = [];
  for (let day = first; day <= last; day = day.plus({ days: 1 })) {
    const iso = day.toISODate()!;
    const windows: Interval[] = [];
    for (const rule of input.rules) {
      if (rule.weekday !== day.weekday) continue;
      if (rule.validFrom && iso < rule.validFrom) continue;
      if (rule.validTo && iso > rule.validTo) continue;
      const span = localSpan(day, rule.startMin, rule.endMin);
      if (span) windows.push(span);
    }
    const closed: Interval[] = [];
    for (const e of byDate.get(iso) ?? []) {
      if (e.kind === 'extra') {
        const span = e.startMin !== null && e.endMin !== null ? localSpan(day, e.startMin, e.endMin) : null;
        if (span) windows.push(span);
        continue;
      }
      const span =
        e.startMin === null || e.endMin === null
          ? localSpan(day, 0, MINUTES_PER_DAY)
          : localSpan(day, e.startMin, e.endMin);
      if (span) closed.push(span);
    }
    out.push(...subtractIntervals(windows, closed));
  }
  return mergeIntervals(out).filter(
    (w) => w.end.getTime() > input.range.start.getTime() && w.start.getTime() < input.range.end.getTime(),
  );
}

/** True when `[start, end)` lies entirely inside one window (CAL-09 marker, CAL-08 check for students). */
export function isInsideWindows(windows: readonly Interval[], during: Interval): boolean {
  return windows.some(
    (w) => w.start.getTime() <= during.start.getTime() && during.end.getTime() <= w.end.getTime(),
  );
}
