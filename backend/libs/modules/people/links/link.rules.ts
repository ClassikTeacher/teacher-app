import { AppError } from '@shared/errors/app-error.js';
import type { AccountStatus } from '@modules/identity/schema.js';
import type { LinkStatus } from '../schema.js';

/** 5.4.2: default weekly limit offered when inviting a student (Р-24). */
export const DEFAULT_MAX_LESSONS_PER_WEEK = 2;
export const MIN_MAX_LESSONS_PER_WEEK = 1;
export const MAX_MAX_LESSONS_PER_WEEK = 50;
/** 5.4.3: up to four parents per student. */
export const MAX_PARENTS_PER_STUDENT = 4;
export const MAX_ALIAS_LENGTH = 60;
export const MAX_NOTES_LENGTH = 2000;
export const MAX_GRADE_LENGTH = 20;
export const MAX_SCHOOL_LENGTH = 120;
export const MAX_GOALS_LENGTH = 500;
export const MAX_END_MESSAGE_LENGTH = 500;
/** 5.8.2: a parent has 7 days to answer a leave request; a reminder goes out after 48 hours. */
export const LEAVE_REQUEST_TTL_HOURS = 7 * 24;
export const LEAVE_REQUEST_REMINDER_HOURS = 48;

/** Weekly limit as stored: null = no limit (PPL-06). */
export function normalizeWeeklyLimit(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < MIN_MAX_LESSONS_PER_WEEK || value > MAX_MAX_LESSONS_PER_WEEK) {
    throw AppError.validation(
      `maxLessonsPerWeek must be an integer between ${MIN_MAX_LESSONS_PER_WEEK} and ${MAX_MAX_LESSONS_PER_WEEK} or null`,
    );
  }
  return value;
}

/** What happens to a pending card when its invitation is accepted, given the existing link of the pair. */
export type AcceptOutcome = 'new' | 'reopen';

export function acceptOutcome(existing: { status: LinkStatus } | null): AcceptOutcome {
  if (!existing) return 'new';
  if (existing.status === 'active') {
    // UC-10 5б: the student already studies with this teacher
    throw new AppError('CONFLICT', 'Student is already linked to this teacher', { reason: 'already_linked' });
  }
  return existing.status === 'ended' ? 'reopen' : 'new';
}

/**
 * Read policy of 8.0: what a student (or their parent) may see of a teacher's data through this link.
 * `full` — active link with an active teacher; `archive` — read-only history (link ended or teacher blocked,
 * ACC-04); `none` — blocked student (ACC-01) or no accepted link.
 */
export type LinkView = 'full' | 'archive' | 'none';

export function linkView(
  link: { status: LinkStatus },
  teacherStatus: AccountStatus,
  studentStatus: AccountStatus,
): LinkView {
  if (studentStatus === 'blocked') return 'none';
  if (link.status === 'active') return teacherStatus === 'blocked' ? 'archive' : 'full';
  if (link.status === 'ended') return 'archive';
  return 'none';
}

/** The teacher may change the card or act on the student only while the link is active (8.0). */
export function assertLinkActive(link: { status: LinkStatus }): void {
  if (link.status !== 'active') {
    throw new AppError('LINK_NOT_ACTIVE', 'The teacher–student link is not active', { status: link.status });
  }
}

/** PPL-05: `max_students` counts active and pending cards; null means no limit. */
export function assertStudentLimit(current: number, limit: number | null): void {
  if (limit !== null && current >= limit) {
    throw new AppError('LIMIT_EXCEEDED', 'Student limit reached', { limit: 'maxStudents', max: limit });
  }
}

export function assertParentLimit(activeParents: number): void {
  if (activeParents >= MAX_PARENTS_PER_STUDENT) {
    throw new AppError('LIMIT_EXCEEDED', 'A student can have at most four parents', {
      limit: 'maxParents',
      max: MAX_PARENTS_PER_STUDENT,
    });
  }
}
