import { MINUTE_MS } from '@shared/time/clock.js';
import type { Interval } from '../schema.js';

export type { Interval };

/** Half-open intervals (CAL-03): `[15:00, 16:00)` and `[16:00, 17:00)` do not overlap. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

export function isValidInterval(i: Interval): boolean {
  return (
    !Number.isNaN(i.start.getTime()) && !Number.isNaN(i.end.getTime()) && i.end.getTime() > i.start.getTime()
  );
}

export function durationMinutes(i: Interval): number {
  return Math.round((i.end.getTime() - i.start.getTime()) / MINUTE_MS);
}

/** The teacher's occupancy of a lesson is widened by the buffers (CAL-04); the students' is not. */
export function withBuffers(i: Interval, beforeMin: number, afterMin: number): Interval {
  return {
    start: new Date(i.start.getTime() - beforeMin * MINUTE_MS),
    end: new Date(i.end.getTime() + afterMin * MINUTE_MS),
  };
}

/** Sorted union: touching and overlapping intervals are merged into one. */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = [...list].filter(isValidInterval).sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out.at(-1);
    if (last && i.start.getTime() <= last.end.getTime()) {
      if (i.end.getTime() > last.end.getTime()) out[out.length - 1] = { start: last.start, end: i.end };
    } else {
      out.push({ start: i.start, end: i.end });
    }
  }
  return out;
}

/** `base − busy`: the free parts of `base` after removing every busy interval. */
export function subtractIntervals(base: readonly Interval[], busy: readonly Interval[]): Interval[] {
  const blockers = mergeIntervals(busy);
  const out: Interval[] = [];
  for (const b of mergeIntervals(base)) {
    let cursor = b.start;
    for (const x of blockers) {
      if (x.end.getTime() <= cursor.getTime()) continue;
      if (x.start.getTime() >= b.end.getTime()) break;
      if (x.start.getTime() > cursor.getTime()) out.push({ start: cursor, end: x.start });
      if (x.end.getTime() > cursor.getTime()) cursor = x.end;
    }
    if (cursor.getTime() < b.end.getTime()) out.push({ start: cursor, end: b.end });
  }
  return out;
}

export function intersectIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of mergeIntervals(a)) {
    for (const y of mergeIntervals(b)) {
      const start = x.start.getTime() > y.start.getTime() ? x.start : y.start;
      const end = x.end.getTime() < y.end.getTime() ? x.end : y.end;
      if (start.getTime() < end.getTime()) out.push({ start, end });
    }
  }
  return mergeIntervals(out);
}

/**
 * Candidate starts inside free intervals on a grid (5.5.4 "шаг сетки"): the grid is anchored to each free
 * interval's own start rounded up to `stepMin` since `gridAnchor` (midnight in the local zone, so 15:00 and 15:30
 * are offered rather than 15:07), and a slot is kept only when `durationMin` fits before the interval ends.
 */
export function sliceSlots(
  free: readonly Interval[],
  durationMin: number,
  stepMin: number,
  gridAnchor: (at: Date) => Date,
): Interval[] {
  const step = Math.max(1, stepMin) * MINUTE_MS;
  const length = Math.max(1, durationMin) * MINUTE_MS;
  const out: Interval[] = [];
  for (const f of mergeIntervals(free)) {
    const anchor = gridAnchor(f.start).getTime();
    let t = anchor + Math.ceil((f.start.getTime() - anchor) / step) * step;
    while (t + length <= f.end.getTime()) {
      out.push({ start: new Date(t), end: new Date(t + length) });
      t += step;
    }
  }
  return out;
}

/** Keeps the parts of `list` within `bounds`. */
export function clampIntervals(list: readonly Interval[], bounds: Interval): Interval[] {
  return intersectIntervals(list, [bounds]);
}
