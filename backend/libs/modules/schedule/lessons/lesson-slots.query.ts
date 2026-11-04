import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { MINUTE_MS } from '@shared/time/clock.js';
import { BusyQuery } from '../occupancy/busy.query.js';
import { sliceSlots, subtractIntervals, withBuffers } from '../occupancy/intervals.js';
import type { Interval } from '../schema.js';
import { TEACHER_DAY_END_MIN, TEACHER_DAY_START_MIN, TEACHER_SUGGESTION_STEP_MIN } from './lesson.rules.js';

export interface TeacherSlotsInput {
  teacherId: string;
  studentIds: readonly string[];
  /** ISO date in the teacher's zone. */
  dateIso: string;
  zone: string;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  /** Slots starting before this instant are not offered. */
  notBefore: Date;
  /** The lesson being moved: its own occupancy must not block the suggestions (M-2). */
  excludeLessonId?: string;
}

/**
 * Free starts a teacher is offered when placing a lesson (5.5.7 "свободное время с учётом занятости выбранного
 * ученика"): the day 07:00–23:00 in the teacher's zone minus the teacher's busy time (the new lesson's own
 * buffers are respected) minus the students' busy time, on a 30-minute grid. Windows are not applied (CAL-09).
 */
@Injectable()
export class LessonSlotsQuery {
  constructor(private readonly busy: BusyQuery) {}

  async teacherSlots(input: TeacherSlotsInput): Promise<Interval[]> {
    const day = DateTime.fromISO(input.dateIso, { zone: input.zone }).startOf('day');
    if (!day.isValid) return [];
    const window: Interval = {
      start: day.plus({ minutes: TEACHER_DAY_START_MIN }).toJSDate(),
      end: day.plus({ minutes: TEACHER_DAY_END_MIN }).toJSDate(),
    };
    const lookup: Interval = {
      start: new Date(window.start.getTime() - 24 * 60 * MINUTE_MS),
      end: new Date(window.end.getTime() + 24 * 60 * MINUTE_MS),
    };
    const busy = await this.busy.busyOf(
      [input.teacherId, ...input.studentIds],
      lookup,
      input.excludeLessonId,
    );
    // a candidate `[s, e)` collides with the teacher's busy time when `[s − before, e + after)` overlaps it,
    // which equals widening each busy interval by `after` on its left and `before` on its right
    const teacherBusy = (busy.get(input.teacherId) ?? []).map((i) =>
      withBuffers(i, input.bufferAfterMin, input.bufferBeforeMin),
    );
    const studentsBusy = input.studentIds.flatMap((id) => busy.get(id) ?? []);
    const free = subtractIntervals([window], [...teacherBusy, ...studentsBusy]);
    const midnight = (at: Date): Date =>
      DateTime.fromJSDate(at, { zone: input.zone }).startOf('day').toJSDate();
    return sliceSlots(free, input.durationMin, TEACHER_SUGGESTION_STEP_MIN, midnight).filter(
      (slot) => slot.start.getTime() >= input.notBefore.getTime(),
    );
  }
}
