import { describe, expect, it } from 'vitest';
import {
  isIsoDay,
  MINUTES_PER_DAY,
  minutesLabel,
  parseDayInput,
  parseTimeInput,
  toInstant,
} from './time-input.js';

const now = new Date('2026-10-19T12:00:00Z');

describe('time input parsing', () => {
  it('parses times in the accepted spellings and rejects nonsense', () => {
    expect(parseTimeInput('16:30')).toBe(16 * 60 + 30);
    expect(parseTimeInput('9:05')).toBe(9 * 60 + 5);
    expect(parseTimeInput('16.30')).toBe(16 * 60 + 30);
    expect(parseTimeInput('1630')).toBe(16 * 60 + 30);
    expect(parseTimeInput('12 30')).toBe(12 * 60 + 30);
    expect(parseTimeInput('16')).toBe(16 * 60);
    expect(parseTimeInput('24:00')).toBeNull();
    expect(parseTimeInput('25:70')).toBeNull();
    expect(parseTimeInput('1.5')).toBeNull();
    expect(parseTimeInput('abc')).toBeNull();
    expect(minutesLabel(MINUTES_PER_DAY)).toBe('24:00');
  });

  it('parses days: this year by default, next year for a day-month already past, explicit years as given', () => {
    expect(parseDayInput('25.10', 'Europe/Minsk', now)).toBe('2026-10-25');
    expect(parseDayInput('18.10', 'Europe/Minsk', now)).toBe('2026-10-18'); // yesterday still counts
    expect(parseDayInput('03.01', 'Europe/Minsk', now)).toBe('2027-01-03');
    expect(parseDayInput('29.02', 'Europe/Minsk', now)).toBeNull(); // 2026 has no Feb 29
    expect(parseDayInput('29.02.2028', 'Europe/Minsk', now)).toBe('2028-02-29');
    expect(parseDayInput('5.11.26', 'Europe/Minsk', now)).toBe('2026-11-05');
    expect(parseDayInput('31.11', 'Europe/Minsk', now)).toBeNull();
    expect(parseDayInput('tomorrow', 'Europe/Minsk', now)).toBeNull();
    expect(isIsoDay('2026-13-45')).toBe(false);
    expect(isIsoDay('2026-10-20')).toBe(true);
    expect(isIsoDay(undefined)).toBe(false);
  });

  it('converts wall-clock time in the zone and respects DST transitions (CAL-05)', () => {
    // Berlin, ordinary day: 14:00 CEST = 12:00Z
    expect(toInstant('2026-10-20', 14 * 60, 'Europe/Berlin')?.toISOString()).toBe('2026-10-20T12:00:00.000Z');
    // spring forward 2026-03-29: 02:30 does not exist
    expect(toInstant('2026-03-29', 2 * 60 + 30, 'Europe/Berlin')).toBeNull();
    // after the gap the typed time is kept: 03:00 CEST = 01:00Z
    expect(toInstant('2026-03-29', 3 * 60, 'Europe/Berlin')?.toISOString()).toBe('2026-03-29T01:00:00.000Z');
    // fall back 2026-10-25: 02:30 is ambiguous; the first occurrence (CEST, +02) is taken
    expect(toInstant('2026-10-25', 2 * 60 + 30, 'Europe/Berlin')?.toISOString()).toBe(
      '2026-10-25T00:30:00.000Z',
    );
    // 24:00 is the next midnight, also on a 25-hour day
    expect(toInstant('2026-10-25', MINUTES_PER_DAY, 'Europe/Berlin')?.toISOString()).toBe(
      '2026-10-25T23:00:00.000Z',
    );
    expect(toInstant('bad', 60, 'Europe/Berlin')).toBeNull();
  });
});
