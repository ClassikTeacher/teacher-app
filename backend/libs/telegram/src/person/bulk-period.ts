import { DateTime } from 'luxon';
import type { Interval } from '@modules/schedule/schema.js';
import { parseDayInput } from '../staff-bot/schedule/time-input.js';

export type PeriodPreset = 'today' | 'tomorrow' | 'week' | 'two-weeks';
export const PERIOD_PRESETS: readonly PeriodPreset[] = ['today', 'tomorrow', 'week', 'two-weeks'];

/** 5.7.5 period buttons: whole local days in the person's zone, `[start, end)`. */
export function periodPreset(preset: PeriodPreset, zone: string, now: Date): Interval {
  const today = DateTime.fromJSDate(now, { zone }).startOf('day');
  const from = preset === 'tomorrow' ? today.plus({ days: 1 }) : today;
  const days = preset === 'week' ? 7 : preset === 'two-weeks' ? 14 : 1;
  return { start: from.toJSDate(), end: from.plus({ days }).toJSDate() };
}

/** `20.10-26.10` (or one date) → whole local days; null when unparsable, inverted, or longer than `maxDays`. */
export function parsePeriodInput(text: string, zone: string, now: Date, maxDays: number): Interval | null {
  const parts = text
    .replace(/[–—]/g, '-')
    .split(/\s*-\s*|\s+/)
    .filter(Boolean);
  if (parts.length === 0 || parts.length > 2) return null;
  const fromIso = parseDayInput(parts[0]!, zone, now);
  const toIso = parts[1] ? parseDayInput(parts[1], zone, now) : fromIso;
  if (!fromIso || !toIso) return null;
  const from = DateTime.fromISO(fromIso, { zone });
  const to = DateTime.fromISO(toIso, { zone });
  if (to < from) return null;
  const end = to.plus({ days: 1 });
  if (end.diff(from, 'days').days > maxDays) return null;
  return { start: from.toJSDate(), end: end.toJSDate() };
}

/** "20.10" or "20.10–26.10" for a `[start, end)` range of whole days. */
export function periodLabel(range: Interval, zone: string): string {
  const from = DateTime.fromJSDate(range.start, { zone });
  const last = DateTime.fromJSDate(new Date(range.end.getTime() - 1), { zone });
  const f = (d: DateTime): string => d.toFormat('dd.MM');
  return from.hasSame(last, 'day') ? f(from) : `${f(from)}–${f(last)}`;
}

/** Stored in the flow session as ISO strings (dates do not survive JSON). */
export interface StoredRange {
  start: string;
  end: string;
}
export const storeRange = (r: Interval): StoredRange => ({
  start: r.start.toISOString(),
  end: r.end.toISOString(),
});
export const loadRange = (r: StoredRange): Interval => ({ start: new Date(r.start), end: new Date(r.end) });
