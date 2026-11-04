import { AppError } from '@shared/errors/app-error.js';
import { HOUR_MS } from '@shared/time/clock.js';
import type { TeacherProfileRow } from '@modules/people/schema.js';
import type { CancelRole, LessonRow } from '../schema.js';

export const MAX_CANCEL_REASON_LENGTH = 500;
/** 5.7.2 💡: templates a user keeps in the profile. */
export const MAX_CANCEL_TEMPLATES = 10;

/** 5.7.2 starter sets live in the locale files (`cancel-template-<role>-<n>`); this is their size. */
export const STARTER_TEMPLATE_COUNT = 3;

export type CancelOutcome = 'cancel' | 'absence';

export interface CancelCheck {
  outcome: CancelOutcome;
  isLate: boolean;
}

export interface CancelPolicyInput {
  role: Exclude<CancelRole, 'SYSTEM' | 'ADMIN'>;
  lesson: Pick<LessonRow, 'status' | 'startsAt' | 'endsAt' | 'groupId'>;
  profile: Pick<
    TeacherProfileRow,
    'lateCancelHours' | 'studentCancelCutoffHours' | 'studentCanCancel' | 'parentCanCancel'
  >;
  now: Date;
}

/** CNL-01: a reason is mandatory and limited; whitespace-only text counts as empty. */
export function normalizeCancelReason(raw: string | null | undefined): string {
  const clean = (raw ?? '').trim();
  if (!clean) throw new AppError('CANCEL_REASON_REQUIRED', 'A reason is required');
  if (clean.length > MAX_CANCEL_REASON_LENGTH)
    throw AppError.validation('Reason is too long', { max: MAX_CANCEL_REASON_LENGTH });
  return clean;
}

/** CNL-06: fewer than `lateCancelHours` hours left before the start; a threshold of 0 switches the mark off. */
export function isLateCancel(
  lesson: Pick<LessonRow, 'startsAt'>,
  lateCancelHours: number,
  now: Date,
): boolean {
  if (lateCancelHours <= 0) return false;
  return lesson.startsAt.getTime() - now.getTime() < lateCancelHours * HOUR_MS;
}

/**
 * CNL-02, CNL-03, CNL-07 (5.7.1): who may cancel what and when. The teacher cancels any own lesson until its end
 * (LES-03); a student or a parent cancels an individual lesson before its start and only reports absence from a
 * group lesson; the teacher may switch their cancelling off or forbid it later than N hours before the start.
 */
export function checkCancel(input: CancelPolicyInput): CancelCheck {
  const { role, lesson, profile, now } = input;
  if (lesson.status !== 'scheduled')
    throw new AppError('CONFLICT', 'Lesson is not scheduled any more', { status: lesson.status });
  const isLate = isLateCancel(lesson, profile.lateCancelHours, now);
  if (role === 'TEACHER') {
    if (lesson.endsAt.getTime() <= now.getTime())
      throw new AppError('CONFLICT', 'The lesson is already over', { reason: 'over' });
    return { outcome: 'cancel', isLate };
  }
  const allowed = role === 'STUDENT' ? profile.studentCanCancel : profile.parentCanCancel;
  if (!allowed) throw new AppError('CANCEL_DISABLED', 'The teacher switched cancelling off', { role });
  if (lesson.startsAt.getTime() <= now.getTime())
    throw new AppError('LESSON_STARTED', 'The lesson has already started');
  const cutoff = profile.studentCancelCutoffHours;
  if (cutoff !== null && lesson.startsAt.getTime() - now.getTime() < cutoff * HOUR_MS)
    throw new AppError('CANCEL_CUTOFF', 'Too late to cancel', { cutoffHours: cutoff });
  return { outcome: lesson.groupId ? 'absence' : 'cancel', isLate };
}
