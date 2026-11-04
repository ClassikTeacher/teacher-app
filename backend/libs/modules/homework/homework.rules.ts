import { AppError } from '@shared/errors/app-error.js';
import type { DueMode, SubmissionMode, SubmissionRules, TargetStatus } from './schema.js';

export const MAX_ASSIGNMENT_TITLE_LENGTH = 200;
export const MAX_ASSIGNMENT_BODY_LENGTH = 4000;
export const MAX_SUBMISSION_TEXT_LENGTH = 4000;
export const MAX_REVIEW_COMMENT_LENGTH = 2000;
/** Upper bound for the per-assignment `maxFiles` rule; the default lets a whole album through (HW-02). */
export const MAX_FILES_PER_SUBMISSION = 20;
export const DEFAULT_MAX_FILES = 10;
/** 5.10.5 💡: «за 24 часа и за 2 часа». */
export const DUE_REMINDER_OFFSETS_MIN = [24 * 60, 2 * 60] as const;

export const DEFAULT_RULES: SubmissionRules = {
  allowResubmit: true,
  acceptLate: true,
  maxFiles: DEFAULT_MAX_FILES,
};

export interface LessonLike {
  id: string;
  startsAt: Date;
}

export interface DueResult {
  dueAt: Date | null;
  dueLessonId: string | null;
}

/**
 * The student's own due date (5.10.1): fixed → the common one; next_lesson → the start of the student's next
 * lesson with the teacher (null when none is scheduled yet: the target waits for one); none → null.
 */
export function dueFor(mode: DueMode, fixedDueAt: Date | null, nextLesson: LessonLike | null): DueResult {
  if (mode === 'fixed') return { dueAt: fixedDueAt, dueLessonId: null };
  if (mode === 'next_lesson') {
    return nextLesson
      ? { dueAt: nextLesson.startsAt, dueLessonId: nextLesson.id }
      : { dueAt: null, dueLessonId: null };
  }
  return { dueAt: null, dueLessonId: null };
}

export function isLate(dueAt: Date | null, at: Date): boolean {
  return dueAt !== null && at.getTime() > dueAt.getTime();
}

/** Statuses from which a student may (re)submit (5.10.2). */
export const SUBMITTABLE: readonly TargetStatus[] = ['assigned', 'overdue', 'returned'];

export interface SubmissionDraft {
  fileCount: number;
  hasText: boolean;
}

/**
 * Validates a submission against the target status and the assignment rules; throws the user-facing codes of
 * UC-27 (`CONFLICT` with a `reason`, `VALIDATION_ERROR` for an empty or oversized submission).
 */
export function assertCanSubmit(
  status: TargetStatus,
  attemptNo: number,
  mode: SubmissionMode,
  rules: SubmissionRules,
  dueAt: Date | null,
  at: Date,
  draft: SubmissionDraft,
): void {
  if (mode === 'none')
    throw new AppError('CONFLICT', 'This assignment takes no submissions', { reason: 'no_submission' });
  if (!SUBMITTABLE.includes(status))
    throw new AppError('CONFLICT', 'Nothing to submit', { reason: `status_${status}` });
  if (attemptNo > 1 && status !== 'returned' && !rules.allowResubmit)
    throw new AppError('CONFLICT', 'Resubmission is not allowed', { reason: 'resubmit_forbidden' });
  // a rework the teacher asked for is never blocked by the deadline; a first (or repeated) submission is
  if (status !== 'returned' && isLate(dueAt, at) && !rules.acceptLate)
    throw new AppError('CONFLICT', 'The due date has passed', { reason: 'late_forbidden' });
  const maxFiles = Math.min(rules.maxFiles ?? DEFAULT_MAX_FILES, MAX_FILES_PER_SUBMISSION);
  if (draft.fileCount > maxFiles)
    throw AppError.validation('Too many files', { reason: 'too_many_files', maxFiles });
  if (mode === 'mark') return; // «Выполнено» needs nothing else
  if (mode === 'files' && draft.fileCount === 0)
    throw AppError.validation('Files are required', { reason: 'files_required' });
  if (mode === 'text' && !draft.hasText)
    throw AppError.validation('A text answer is required', { reason: 'text_required' });
  if (mode === 'files_text' && draft.fileCount === 0 && !draft.hasText)
    throw AppError.validation('Send files or a text', { reason: 'empty' });
  if (mode === 'text' && draft.fileCount > 0)
    throw AppError.validation('Only a text answer is accepted', { reason: 'text_only' });
}

/** Normalises rules coming from the teacher (bot or REST). */
export function normalizeRules(
  input: Partial<SubmissionRules> | null | undefined,
  platformExts: readonly string[],
): SubmissionRules {
  const allowedExts = input?.allowedExts
    ? [...new Set(input.allowedExts.map((e) => e.toLowerCase()).filter((e) => platformExts.includes(e)))]
    : undefined;
  if (input?.allowedExts && (!allowedExts || allowedExts.length === 0))
    throw AppError.validation('allowedExts must be a non-empty subset of the platform list');
  const maxFiles = input?.maxFiles ?? DEFAULT_MAX_FILES;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_FILES_PER_SUBMISSION)
    throw AppError.validation(`maxFiles must be between 1 and ${MAX_FILES_PER_SUBMISSION}`);
  return {
    ...(allowedExts ? { allowedExts } : {}),
    maxFiles,
    allowResubmit: input?.allowResubmit ?? DEFAULT_RULES.allowResubmit,
    acceptLate: input?.acceptLate ?? DEFAULT_RULES.acceptLate,
  };
}
