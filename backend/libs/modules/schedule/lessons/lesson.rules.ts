import { AppError } from '@shared/errors/app-error.js';
import {
  MAX_LESSON_DURATION_MIN,
  MIN_LESSON_DURATION_MIN,
} from '@modules/people/teacher-profile.defaults.js';
import type { LessonFormat, LessonRow, LessonStatus } from '../schema.js';

export const MAX_TOPIC_LENGTH = 200;
export const MAX_LOCATION_LENGTH = 200;
export const MAX_MEETING_URL_LENGTH = 500;
export const MAX_COMMENT_LENGTH = 2000;
export const MAX_NOT_HELD_REASON_LENGTH = 500;
/** How far ahead a lesson may be placed by hand. */
export const MAX_LESSON_HORIZON_DAYS = 366;
/** Grid of suggested start times offered to a teacher (5.5.7); windows are no constraint for them (CAL-09). */
export const TEACHER_SUGGESTION_STEP_MIN = 30;
export const TEACHER_DAY_START_MIN = 7 * 60;
export const TEACHER_DAY_END_MIN = 23 * 60;

export interface LessonDetailsInput {
  subjectId?: string | null;
  plannedTopic?: string | null;
  format?: LessonFormat | null;
  location?: string | null;
  meetingUrl?: string | null;
  teacherNotes?: string | null;
}

export function normalizeDuration(durationMin: number): number {
  if (
    !Number.isInteger(durationMin) ||
    durationMin < MIN_LESSON_DURATION_MIN ||
    durationMin > MAX_LESSON_DURATION_MIN
  ) {
    throw AppError.validation('Lesson duration is out of range', {
      min: MIN_LESSON_DURATION_MIN,
      max: MAX_LESSON_DURATION_MIN,
    });
  }
  return durationMin;
}

const limited = (value: string | null | undefined, max: number, field: string): string | null => {
  if (value === undefined || value === null) return null;
  const clean = value.trim();
  if (clean.length > max) throw AppError.validation(`${field} is too long`, { max });
  return clean || null;
};

/** Trims optional texts and enforces the lengths of the SQL CHECKs; returns only the given fields. */
export function normalizeLessonDetails(input: LessonDetailsInput): LessonDetailsInput {
  const out: LessonDetailsInput = {};
  if (input.subjectId !== undefined) out.subjectId = input.subjectId;
  if (input.plannedTopic !== undefined)
    out.plannedTopic = limited(input.plannedTopic, MAX_TOPIC_LENGTH, 'plannedTopic');
  if (input.format !== undefined) out.format = input.format;
  if (input.location !== undefined) out.location = limited(input.location, MAX_LOCATION_LENGTH, 'location');
  if (input.meetingUrl !== undefined)
    out.meetingUrl = limited(input.meetingUrl, MAX_MEETING_URL_LENGTH, 'meetingUrl');
  if (input.teacherNotes !== undefined)
    out.teacherNotes = limited(input.teacherNotes, MAX_COMMENT_LENGTH, 'teacherNotes');
  return out;
}

/** Statuses after which the lesson no longer occupies time (5.6.2). */
export const INACTIVE_STATUSES: readonly LessonStatus[] = ['cancelled', 'completed', 'not_held'];

export function isFuture(lesson: Pick<LessonRow, 'startsAt'>, now: Date): boolean {
  return lesson.startsAt.getTime() > now.getTime();
}

/** LES-01: a scheduled lesson whose end has passed is waiting for the teacher's report. */
export function isOver(lesson: Pick<LessonRow, 'endsAt'>, now: Date): boolean {
  return lesson.endsAt.getTime() <= now.getTime();
}

export function assertScheduled(lesson: Pick<LessonRow, 'status'>): void {
  if (lesson.status !== 'scheduled') {
    throw new AppError('CONFLICT', 'Lesson is not scheduled any more', { status: lesson.status });
  }
}
