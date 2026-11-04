import { DateTime } from 'luxon';
import { clampIntervals, sliceSlots, subtractIntervals, withBuffers } from '../occupancy/intervals.js';
import type { Interval } from '../schema.js';

export interface SlotCalculationInput {
  windows: readonly Interval[];
  /** The teacher's busy intervals (lessons already carry their buffers, blocks do not). */
  teacherBusy: readonly Interval[];
  /** Buffers the new lesson itself would need around it (CAL-04). */
  bufferBeforeMin: number;
  bufferAfterMin: number;
  studentBusy: readonly Interval[];
  gridStepMin: number;
  durationMin: number;
  /** Only slots inside this range (horizon, minimum notice) are returned. */
  range: Interval;
  zone: string;
}

/**
 * 5.5.4 "Открытые слоты": windows − teacher busy (with the new lesson's buffers) − student busy, sliced on the
 * grid for one duration. Pending booking requests (5.5.5 "N заявок") are subtracted by the caller in M4.
 */
export function computeOpenSlots(input: SlotCalculationInput): Interval[] {
  const teacherBusy = input.teacherBusy.map((i) =>
    withBuffers(i, input.bufferAfterMin, input.bufferBeforeMin),
  );
  const free = subtractIntervals(clampIntervals(input.windows, input.range), [
    ...teacherBusy,
    ...input.studentBusy,
  ]);
  const midnight = (at: Date): Date =>
    DateTime.fromJSDate(at, { zone: input.zone }).startOf('day').toJSDate();
  return sliceSlots(free, input.durationMin, input.gridStepMin, midnight);
}
