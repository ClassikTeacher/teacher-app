import { describe, expect, it } from 'vitest';
import { deferForQuietHours, isCritical, normalizeOffsets, timeToMinutes } from './delivery-policy.js';

const quiet = { quietEnabled: true, quietFrom: '22:00:00', quietTo: '08:00:00' };
const minsk = 'Europe/Minsk'; // UTC+3

describe('delivery policy (5.13.3, NTF-02, NTF-06)', () => {
  it('validates reminder offsets: at most three of the known options, sorted, unique; empty switches off', () => {
    expect(normalizeOffsets([60, 1440, 60])).toEqual([1440, 60]);
    expect(normalizeOffsets([])).toEqual([]);
    expect(() => normalizeOffsets([15, 30, 60, 120])).toThrow();
    expect(() => normalizeOffsets([45])).toThrow();
    expect(timeToMinutes('08:30')).toBe(510);
    expect(() => timeToMinutes('25:00')).toThrow();
  });

  it('time-sensitive types are critical only within 48 h of the lesson; other critical types always', () => {
    const now = new Date('2026-10-19T12:00:00Z');
    expect(isCritical('lesson.cancelled', new Date('2026-10-20T12:00:00Z'), now)).toBe(true);
    expect(isCritical('lesson.cancelled', new Date('2026-10-22T12:00:00Z'), now)).toBe(false);
    expect(isCritical('lesson.cancelled', null, now)).toBe(false);
    expect(isCritical('link.ended', null, now)).toBe(true);
    expect(isCritical('lesson.summary', null, now)).toBe(false);
  });

  it('defers a message inside quiet hours to their end in the recipient zone; outside — unchanged', () => {
    // 23:30 Minsk → 08:00 next morning
    expect(deferForQuietHours(new Date('2026-10-19T20:30:00Z'), quiet, minsk)).toEqual(
      new Date('2026-10-20T05:00:00Z'),
    );
    // 06:00 Minsk → 08:00 the same morning
    expect(deferForQuietHours(new Date('2026-10-20T03:00:00Z'), quiet, minsk)).toEqual(
      new Date('2026-10-20T05:00:00Z'),
    );
    // 12:00 Minsk → unchanged; 22:00 sharp → deferred; 08:00 sharp → unchanged
    expect(deferForQuietHours(new Date('2026-10-20T09:00:00Z'), quiet, minsk)).toEqual(
      new Date('2026-10-20T09:00:00Z'),
    );
    expect(deferForQuietHours(new Date('2026-10-20T19:00:00Z'), quiet, minsk)).toEqual(
      new Date('2026-10-21T05:00:00Z'),
    );
    expect(deferForQuietHours(new Date('2026-10-20T05:00:00Z'), quiet, minsk)).toEqual(
      new Date('2026-10-20T05:00:00Z'),
    );
    // a daytime quiet window (13:00–15:00) and switched-off quiet hours
    const day = { quietEnabled: true, quietFrom: '13:00:00', quietTo: '15:00:00' };
    expect(deferForQuietHours(new Date('2026-10-20T11:00:00Z'), day, minsk)).toEqual(
      new Date('2026-10-20T12:00:00Z'),
    );
    expect(
      deferForQuietHours(new Date('2026-10-20T20:30:00Z'), { ...quiet, quietEnabled: false }, minsk),
    ).toEqual(new Date('2026-10-20T20:30:00Z'));
  });
});
