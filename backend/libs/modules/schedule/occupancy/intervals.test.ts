import { describe, expect, it } from 'vitest';
import {
  intersectIntervals,
  mergeIntervals,
  overlaps,
  sliceSlots,
  subtractIntervals,
  withBuffers,
} from './intervals.js';

const t = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 20, h, m));
const iv = (a: Date, b: Date) => ({ start: a, end: b });

describe('intervals (CAL-03, CAL-04)', () => {
  it('half-open intervals that touch do not overlap', () => {
    expect(overlaps(iv(t(15), t(16)), iv(t(16), t(17)))).toBe(false);
    expect(overlaps(iv(t(15), t(16)), iv(t(15, 59), t(17)))).toBe(true);
    expect(overlaps(iv(t(15), t(16)), iv(t(14), t(15, 1)))).toBe(true);
  });

  it('buffers widen the interval on both sides', () => {
    expect(withBuffers(iv(t(15), t(16)), 10, 5)).toEqual(iv(t(14, 50), t(16, 5)));
  });

  it('merges touching and overlapping intervals, keeps gaps', () => {
    expect(
      mergeIntervals([iv(t(16), t(17)), iv(t(15), t(16)), iv(t(18), t(19)), iv(t(18, 30), t(18, 45))]),
    ).toEqual([iv(t(15), t(17)), iv(t(18), t(19))]);
  });

  it('subtracts busy time from windows', () => {
    const free = subtractIntervals(
      [iv(t(10), t(14))],
      [iv(t(9), t(10, 30)), iv(t(12), t(12, 30)), iv(t(13, 45), t(15))],
    );
    expect(free).toEqual([iv(t(10, 30), t(12)), iv(t(12, 30), t(13, 45))]);
    expect(subtractIntervals([iv(t(10), t(11))], [iv(t(9), t(12))])).toEqual([]);
    expect(subtractIntervals([iv(t(10), t(11))], [])).toEqual([iv(t(10), t(11))]);
  });

  it('intersects two sets', () => {
    expect(intersectIntervals([iv(t(10), t(12))], [iv(t(11), t(13)), iv(t(9), t(10, 15))])).toEqual([
      iv(t(10), t(10, 15)),
      iv(t(11), t(12)),
    ]);
  });

  it('slices free time into grid-aligned slots that fit the duration', () => {
    const midnight = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const slots = sliceSlots([iv(t(10, 7), t(11, 45))], 60, 30, midnight);
    expect(slots).toEqual([iv(t(10, 30), t(11, 30))]);
    expect(sliceSlots([iv(t(10), t(10, 45))], 60, 15, midnight)).toEqual([]);
    expect(sliceSlots([iv(t(10), t(11))], 30, 30, midnight)).toHaveLength(2);
  });
});
