import { DateTime } from 'luxon';
import type { Interval } from '@modules/schedule/schema.js';

export const DAY_ISO = 'yyyy-MM-dd';
export const DAY_LABEL = 'ccc dd.MM';
export const TIME_LABEL = 'HH:mm';

/** Start of the day `offsetDays` from now in the person's zone. */
export function localDay(zone: string, now: Date, offsetDays = 0): DateTime {
  return DateTime.fromJSDate(now, { zone }).startOf('day').plus({ days: offsetDays });
}

/** `[start of day, start of next day)` in UTC for an ISO date in the zone. */
export function dayRange(dateIso: string, zone: string): Interval {
  const start = DateTime.fromISO(dateIso, { zone }).startOf('day');
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate() };
}

export function daysRange(dateIso: string, zone: string, days: number): Interval {
  const start = DateTime.fromISO(dateIso, { zone }).startOf('day');
  return { start: start.toJSDate(), end: start.plus({ days }).toJSDate() };
}

/** `ДД.ММ` or `ДД.ММ.ГГГГ` → ISO date; a day-month earlier than yesterday is read as next year. */
export function parseDayInput(text: string, zone: string, now: Date): string | null {
  const m = /^(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2}|\d{4}))?$/.exec(text.trim());
  if (!m) return null;
  const today = localDay(zone, now);
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = m[3] ? Number(m[3]) : today.year;
  if (m[3] && m[3].length === 2) year += 2000;
  let candidate = DateTime.fromObject({ year, month, day }, { zone });
  if (!candidate.isValid) return null;
  if (!m[3] && candidate < today.minus({ days: 1 })) candidate = candidate.plus({ years: 1 });
  return candidate.toFormat(DAY_ISO);
}

/** `ЧЧ:ММ`, `Ч:ММ`, `ЧЧ.ММ`, `ЧЧММ`, `ЧЧ` → minutes since midnight. */
export function parseTimeInput(text: string): number | null {
  const m = /^(\d{1,2})(?:[:.\s]?(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function minutesLabel(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export const MINUTES_PER_DAY = 24 * 60;

export function isIsoDay(value: string | undefined): value is string {
  return value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value) && DateTime.fromISO(value).isValid;
}

/**
 * Local date + minutes since midnight → UTC instant as wall-clock time in the zone (CAL-05). Returns null for a
 * time that does not exist on that day (spring-forward gap); `MINUTES_PER_DAY` means the next midnight. In the
 * repeated hour of a fall-back day Luxon picks the first occurrence.
 */
export function toInstant(dateIso: string, minutes: number, zone: string): Date | null {
  const day = DateTime.fromISO(dateIso, { zone }).startOf('day');
  if (!day.isValid) return null;
  if (minutes === MINUTES_PER_DAY) return day.plus({ days: 1 }).toJSDate();
  const local = day.set({ hour: Math.floor(minutes / 60), minute: minutes % 60 });
  if (local.hour * 60 + local.minute !== minutes) return null;
  return local.toJSDate();
}

export function fmtTime(at: Date, zone: string): string {
  return DateTime.fromJSDate(at, { zone }).toFormat(TIME_LABEL);
}

export function fmtDay(dateIso: string, zone: string, locale = 'ru'): string {
  return DateTime.fromISO(dateIso, { zone }).setLocale(locale).toFormat(DAY_LABEL);
}

export function fmtDayOf(at: Date, zone: string, locale = 'ru'): string {
  return DateTime.fromJSDate(at, { zone }).setLocale(locale).toFormat(DAY_LABEL);
}

export function isoDayOf(at: Date, zone: string): string {
  return DateTime.fromJSDate(at, { zone }).toFormat(DAY_ISO);
}
