import { boolean, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { idColumn, timestamps, tstz } from '@shared/db/columns.js';
import { collection } from '@modules/content/schema.js';
import { file } from '@modules/files/schema.js';
import { account } from '@modules/identity/schema.js';
import { studyGroup } from '@modules/people/schema.js';
import { lesson } from '@modules/schedule/schema.js';

// M5-03 / M5-04 (migration 0017). SQL is the source of truth; CHECKs live only there.

export const DUE_MODES = ['fixed', 'next_lesson', 'none'] as const;
export type DueMode = (typeof DUE_MODES)[number];
export const SUBMISSION_MODES = ['files', 'text', 'files_text', 'mark', 'none'] as const;
export type SubmissionMode = (typeof SUBMISSION_MODES)[number];
export const ASSIGNMENT_STATUSES = ['draft', 'published', 'closed'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
export const TARGET_STATUSES = [
  'assigned',
  'submitted',
  'overdue',
  'returned',
  'accepted',
  'withdrawn',
] as const;
export type TargetStatus = (typeof TARGET_STATUSES)[number];
export const REVIEW_DECISIONS = ['accepted', 'returned'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** 5.10.1 «Правила сдачи». */
export interface SubmissionRules {
  /** Subset of the platform list; undefined = everything the platform allows. */
  allowedExts?: string[];
  maxFiles?: number;
  allowResubmit: boolean;
  acceptLate: boolean;
}

/** 5.10.1 «Оценивание»; `journal` is wired by M6-01. */
export type Grading =
  { kind: 'none' } | { kind: 'pass_fail' } | { kind: 'journal'; journalId: string; scaleId: string | null };

export const assignment = pgTable('assignment', {
  id: idColumn(),
  teacherId: uuid('teacher_id')
    .notNull()
    .references(() => account.id),
  title: text('title').notNull(),
  body: text('body'),
  dueMode: text('due_mode', { enum: DUE_MODES }).notNull(),
  dueAt: tstz('due_at'),
  assignedLessonId: uuid('assigned_lesson_id').references(() => lesson.id),
  checkLessonId: uuid('check_lesson_id').references(() => lesson.id),
  collectionId: uuid('collection_id').references(() => collection.id),
  submissionMode: text('submission_mode', { enum: SUBMISSION_MODES }).notNull(),
  submissionRules: jsonb('submission_rules').$type<SubmissionRules>().notNull(),
  grading: jsonb('grading').$type<Grading>().notNull(),
  status: text('status', { enum: ASSIGNMENT_STATUSES }).notNull().default('draft'),
  publishedAt: tstz('published_at'),
  closedAt: tstz('closed_at'),
  ...timestamps(),
});
export type AssignmentRow = typeof assignment.$inferSelect;
export type AssignmentInsert = typeof assignment.$inferInsert;

export const assignmentGroup = pgTable(
  'assignment_group',
  {
    id: idColumn(),
    assignmentId: uuid('assignment_id')
      .notNull()
      .references(() => assignment.id),
    groupId: uuid('group_id')
      .notNull()
      .references(() => studyGroup.id),
  },
  (t) => [unique('assignment_group_assignment_id_group_id_key').on(t.assignmentId, t.groupId)],
);

export const assignmentTarget = pgTable(
  'assignment_target',
  {
    id: idColumn(),
    assignmentId: uuid('assignment_id')
      .notNull()
      .references(() => assignment.id),
    studentId: uuid('student_id')
      .notNull()
      .references(() => account.id),
    dueAt: tstz('due_at'),
    dueLessonId: uuid('due_lesson_id').references(() => lesson.id),
    status: text('status', { enum: TARGET_STATUSES }).notNull().default('assigned'),
    viewedAt: tstz('viewed_at'),
    overdueNotifiedAt: tstz('overdue_notified_at'),
    ...timestamps(),
  },
  (t) => [unique('assignment_target_assignment_id_student_id_key').on(t.assignmentId, t.studentId)],
);
export type AssignmentTargetRow = typeof assignmentTarget.$inferSelect;
export type AssignmentTargetInsert = typeof assignmentTarget.$inferInsert;

export const submission = pgTable(
  'submission',
  {
    id: idColumn(),
    assignmentId: uuid('assignment_id')
      .notNull()
      .references(() => assignment.id),
    targetId: uuid('target_id')
      .notNull()
      .references(() => assignmentTarget.id),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => account.id),
    studentId: uuid('student_id')
      .notNull()
      .references(() => account.id),
    attemptNo: integer('attempt_no').notNull(),
    text: text('text'),
    submittedAt: tstz('submitted_at').notNull(),
    isLate: boolean('is_late').notNull().default(false),
  },
  (t) => [unique('submission_target_id_attempt_no_key').on(t.targetId, t.attemptNo)],
);
export type SubmissionRow = typeof submission.$inferSelect;
export type SubmissionInsert = typeof submission.$inferInsert;

export const submissionFile = pgTable('submission_file', {
  id: idColumn(),
  submissionId: uuid('submission_id')
    .notNull()
    .references(() => submission.id),
  fileId: uuid('file_id')
    .notNull()
    .references(() => file.id),
  position: integer('position').notNull().default(0),
});
export type SubmissionFileRow = typeof submissionFile.$inferSelect;

export const submissionReview = pgTable('submission_review', {
  id: idColumn(),
  submissionId: uuid('submission_id')
    .notNull()
    .references(() => submission.id),
  reviewerId: uuid('reviewer_id')
    .notNull()
    .references(() => account.id),
  decision: text('decision', { enum: REVIEW_DECISIONS }).notNull(),
  comment: text('comment'),
  gradeEntryId: uuid('grade_entry_id'),
  reviewedAt: tstz('reviewed_at').notNull(),
});
export type SubmissionReviewRow = typeof submissionReview.$inferSelect;

export const submissionReviewFile = pgTable('submission_review_file', {
  id: idColumn(),
  reviewId: uuid('review_id')
    .notNull()
    .references(() => submissionReview.id),
  fileId: uuid('file_id')
    .notNull()
    .references(() => file.id),
  position: integer('position').notNull().default(0),
});
export type SubmissionReviewFileRow = typeof submissionReviewFile.$inferSelect;
