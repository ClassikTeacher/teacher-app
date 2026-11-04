import { AppError } from '@shared/errors/app-error.js';
import { isValidTimezone } from '@shared/time/timezone.js';
import { MAX_PERSON_NAME_LENGTH } from './person-onboarding.service.js';
import { MAX_LESSON_DURATION_MIN, MIN_LESSON_DURATION_MIN } from './teacher-profile.defaults.js';
import { type BookingRules, BOOKING_CONFIRMATIONS, type CalendarMode, CALENDAR_MODES } from './schema.js';

export const MAX_BUFFER_MIN = 120;
export const MAX_CANCEL_HOURS = 24 * 14;
export const MAX_NOTICE_TEXT_LENGTH = 500;
export const MAX_TEMPLATE_TEXT_LENGTH = 500;
export const MAX_TEMPLATES_PER_KIND = 20;

/** Settings a teacher edits in «Настройки» and via PATCH /me (3.4, 8.2 teacher_profile). */
export interface TeacherSettingsPatch {
  firstName?: string;
  lastName?: string;
  timezone?: string;
  subjectIds?: string[];
  defaultDurationMin?: number;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
  lateCancelHours?: number;
  /** Null = students may cancel until the lesson starts (CNL rules apply in M4). */
  studentCancelCutoffHours?: number | null;
  studentCanCancel?: boolean;
  parentCanCancel?: boolean;
  defaultNoticeText?: string;
  /** 5.5.5 "Режим": closed / open for all students / open for selected ones (card override). */
  calendarMode?: CalendarMode;
  /** 5.5.5: `auto` (default, Р-7) creates the lesson at once, `manual` makes a request the teacher decides. */
  bookingConfirmation?: (typeof BOOKING_CONFIRMATIONS)[number];
  /** 5.5.5 booking rules; a partial patch is merged over the stored rules. */
  bookingRules?: BookingRules;
}

export const MAX_MIN_NOTICE_HOURS = 24 * 14;
export const MAX_HORIZON_DAYS = 90;
export const MAX_BOOKING_DURATIONS = 6;
export const MAX_PENDING_PER_SLOT = 10;
export const GRID_STEPS = [15, 30, 60] as const;

/** Validates a (partial) set of booking rules (5.5.5); returns only the given fields. */
export function normalizeBookingRules(patch: BookingRules): BookingRules {
  const clean: BookingRules = {};
  if (patch.minNoticeHours !== undefined)
    clean.minNoticeHours = intInRange(patch.minNoticeHours, 0, MAX_MIN_NOTICE_HOURS, 'minNoticeHours');
  if (patch.horizonDays !== undefined)
    clean.horizonDays = intInRange(patch.horizonDays, 1, MAX_HORIZON_DAYS, 'horizonDays');
  if (patch.durations !== undefined) {
    const unique = [...new Set(patch.durations)].sort((a, b) => a - b);
    if (unique.length > MAX_BOOKING_DURATIONS)
      throw AppError.validation('Too many durations', { max: MAX_BOOKING_DURATIONS });
    unique.forEach((d) => intInRange(d, MIN_LESSON_DURATION_MIN, MAX_LESSON_DURATION_MIN, 'durations'));
    clean.durations = unique;
  }
  if (patch.gridStepMin !== undefined) {
    if (!(GRID_STEPS as readonly number[]).includes(patch.gridStepMin))
      throw AppError.validation('gridStepMin must be 15, 30 or 60');
    clean.gridStepMin = patch.gridStepMin;
  }
  if (patch.maxPendingPerSlot !== undefined)
    clean.maxPendingPerSlot = intInRange(
      patch.maxPendingPerSlot,
      1,
      MAX_PENDING_PER_SLOT,
      'maxPendingPerSlot',
    );
  return clean;
}

const intInRange = (value: unknown, min: number, max: number, field: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw AppError.validation(`${field} must be an integer between ${min} and ${max}`, { min, max });
  }
  return value;
};

/** Pure validation and normalisation of a settings patch; throws VALIDATION_ERROR. */
export function normalizeTeacherSettings(patch: TeacherSettingsPatch): TeacherSettingsPatch {
  const clean: TeacherSettingsPatch = {};
  if (patch.firstName !== undefined) {
    const v = patch.firstName.trim();
    if (!v || v.length > MAX_PERSON_NAME_LENGTH)
      throw AppError.validation('firstName is required and limited');
    clean.firstName = v;
  }
  if (patch.lastName !== undefined) {
    const v = patch.lastName.trim();
    if (v.length > MAX_PERSON_NAME_LENGTH) throw AppError.validation('lastName is too long');
    clean.lastName = v;
  }
  if (patch.timezone !== undefined) {
    if (!isValidTimezone(patch.timezone)) throw AppError.validation('Unknown timezone');
    clean.timezone = patch.timezone;
  }
  if (patch.subjectIds !== undefined) {
    const unique = [...new Set(patch.subjectIds)];
    if (unique.length === 0) throw AppError.validation('At least one subject is required');
    clean.subjectIds = unique;
  }
  if (patch.defaultDurationMin !== undefined) {
    clean.defaultDurationMin = intInRange(
      patch.defaultDurationMin,
      MIN_LESSON_DURATION_MIN,
      MAX_LESSON_DURATION_MIN,
      'defaultDurationMin',
    );
  }
  if (patch.bufferBeforeMin !== undefined)
    clean.bufferBeforeMin = intInRange(patch.bufferBeforeMin, 0, MAX_BUFFER_MIN, 'bufferBeforeMin');
  if (patch.bufferAfterMin !== undefined)
    clean.bufferAfterMin = intInRange(patch.bufferAfterMin, 0, MAX_BUFFER_MIN, 'bufferAfterMin');
  if (patch.lateCancelHours !== undefined)
    clean.lateCancelHours = intInRange(patch.lateCancelHours, 0, MAX_CANCEL_HOURS, 'lateCancelHours');
  if (patch.studentCancelCutoffHours !== undefined) {
    clean.studentCancelCutoffHours =
      patch.studentCancelCutoffHours === null
        ? null
        : intInRange(patch.studentCancelCutoffHours, 0, MAX_CANCEL_HOURS, 'studentCancelCutoffHours');
  }
  if (patch.studentCanCancel !== undefined) clean.studentCanCancel = patch.studentCanCancel === true;
  if (patch.parentCanCancel !== undefined) clean.parentCanCancel = patch.parentCanCancel === true;
  if (patch.calendarMode !== undefined) {
    if (!CALENDAR_MODES.includes(patch.calendarMode)) throw AppError.validation('Unknown calendar mode');
    clean.calendarMode = patch.calendarMode;
  }
  if (patch.bookingConfirmation !== undefined) {
    if (!BOOKING_CONFIRMATIONS.includes(patch.bookingConfirmation))
      throw AppError.validation('Unknown booking confirmation mode');
    clean.bookingConfirmation = patch.bookingConfirmation;
  }
  if (patch.bookingRules !== undefined) clean.bookingRules = normalizeBookingRules(patch.bookingRules);
  if (patch.defaultNoticeText !== undefined) {
    const v = patch.defaultNoticeText.trim();
    if (!v || v.length > MAX_NOTICE_TEXT_LENGTH)
      throw AppError.validation('defaultNoticeText is required and limited');
    clean.defaultNoticeText = v;
  }
  return clean;
}
