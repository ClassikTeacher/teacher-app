import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { idColumn, timestamps, tstz } from '@shared/db/columns.js';
import { account } from '@modules/identity/schema.js';

/** Platform subject catalogue (Р-31). SQL in migrations/ is the source of truth. */
export const subject = pgTable(
  'subject',
  {
    id: idColumn(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    position: integer('position').notNull().default(0),
    createdBy: uuid('created_by').references(() => account.id),
    ...timestamps(),
  },
  (t) => [uniqueIndex('subject_name_uniq').on(sql`lower(${t.name})`)],
);

export type SubjectRow = typeof subject.$inferSelect;

export const CALENDAR_MODES = ['closed', 'open_all', 'open_selected'] as const;
export type CalendarMode = (typeof CALENDAR_MODES)[number];
export const BOOKING_CONFIRMATIONS = ['auto', 'manual'] as const;

export interface BookingRules {
  minNoticeHours?: number;
  horizonDays?: number;
  durations?: number[];
  gridStepMin?: 15 | 30 | 60;
  maxPendingPerSlot?: number;
}

/** Teacher settings (8.2 teacher_profile); created when onboarding completes (5.1.2). */
export const teacherProfile = pgTable('teacher_profile', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => account.id),
  subjectIds: uuid('subject_ids').array().notNull().default([]),
  defaultDurationMin: integer('default_duration_min').notNull().default(60),
  bufferBeforeMin: integer('buffer_before_min').notNull().default(0),
  bufferAfterMin: integer('buffer_after_min').notNull().default(0),
  calendarMode: text('calendar_mode', { enum: CALENDAR_MODES }).notNull().default('closed'),
  bookingConfirmation: text('booking_confirmation', { enum: BOOKING_CONFIRMATIONS })
    .notNull()
    .default('auto'),
  bookingRules: jsonb('booking_rules').$type<BookingRules>().notNull().default({}),
  lateCancelHours: integer('late_cancel_hours').notNull().default(24),
  studentCancelCutoffHours: integer('student_cancel_cutoff_hours'),
  studentCanCancel: boolean('student_can_cancel').notNull().default(true),
  parentCanCancel: boolean('parent_can_cancel').notNull().default(true),
  defaultNoticeText: text('default_notice_text').notNull().default(''),
  /** M6-01 (migration 0018): a grade entered by the student or a parent is accepted without confirmation (5.11.2 💡). */
  gradeAutoConfirm: boolean('grade_auto_confirm').notNull().default(false),
  onboardedAt: tstz('onboarded_at'),
  ...timestamps(),
});

export type TeacherProfileRow = typeof teacherProfile.$inferSelect;
export type TeacherProfileInsert = typeof teacherProfile.$inferInsert;

// ---------------------------------------------------------------------------------------------------
// M2: people links (migrations 0009, 0010). SQL is the source of truth; CHECKs live only there.
// ---------------------------------------------------------------------------------------------------

/** Student-owned facts shared by all teachers (5.4.1). */
export const studentProfile = pgTable('student_profile', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => account.id),
  school: text('school'),
  grade: text('grade'),
  onboardedAt: tstz('onboarded_at'),
  ...timestamps(),
});
export type StudentProfileRow = typeof studentProfile.$inferSelect;

export const LINK_STATUSES = ['pending', 'active', 'ended', 'declined', 'cancelled'] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

export const END_REASONS = ['removed_by_teacher', 'left_by_student', 'ended_by_parent', 'system'] as const;
export type EndReason = (typeof END_REASONS)[number];

/** Teacher–student link = the student's card at this teacher (5.4.1, 3.8). */
export const teacherStudent = pgTable(
  'teacher_student',
  {
    id: idColumn(),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => account.id),
    studentId: uuid('student_id').references(() => account.id),
    status: text('status', { enum: LINK_STATUSES }).notNull().default('pending'),
    invitationId: uuid('invitation_id'),
    inviteName: text('invite_name'),
    inviteGrade: text('invite_grade'),
    alias: text('alias'),
    subjectIds: uuid('subject_ids').array().notNull().default([]),
    maxLessonsPerWeek: integer('max_lessons_per_week'),
    goals: text('goals'),
    notes: text('notes'),
    calendarOpen: boolean('calendar_open'),
    startedAt: tstz('started_at'),
    endedAt: tstz('ended_at'),
    endedBy: uuid('ended_by').references(() => account.id),
    endReason: text('end_reason', { enum: END_REASONS }),
    endMessage: text('end_message'),
    /** M3: counter behind lesson.seq_no ("Занятие №N"), migration 0011. */
    lessonSeq: integer('lesson_seq').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('teacher_student_pair_uniq')
      .on(t.teacherId, t.studentId)
      .where(sql`${t.studentId} IS NOT NULL`),
    index('teacher_student_teacher_idx').on(t.teacherId, t.status),
    uniqueIndex('teacher_student_invitation_uniq')
      .on(t.invitationId)
      .where(sql`${t.invitationId} IS NOT NULL`),
  ],
);
export type TeacherStudentRow = typeof teacherStudent.$inferSelect;
export type TeacherStudentInsert = typeof teacherStudent.$inferInsert;

export const teacherStudentPeriod = pgTable(
  'teacher_student_period',
  {
    id: idColumn(),
    linkId: uuid('link_id')
      .notNull()
      .references(() => teacherStudent.id),
    startedAt: tstz('started_at').notNull(),
    endedAt: tstz('ended_at'),
    endReason: text('end_reason', { enum: END_REASONS }),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [index('teacher_student_period_link_idx').on(t.linkId, t.startedAt)],
);
export type TeacherStudentPeriodRow = typeof teacherStudentPeriod.$inferSelect;

export const FAMILY_STATUSES = ['active', 'revoked'] as const;
export type FamilyStatus = (typeof FAMILY_STATUSES)[number];

/** Family link parent–child, shared by every teacher of the student (5.4.3). */
export const familyLink = pgTable(
  'family_link',
  {
    id: idColumn(),
    parentId: uuid('parent_id')
      .notNull()
      .references(() => account.id),
    studentId: uuid('student_id')
      .notNull()
      .references(() => account.id),
    status: text('status', { enum: FAMILY_STATUSES }).notNull().default('active'),
    invitedBy: uuid('invited_by').references(() => account.id),
    invitationId: uuid('invitation_id'),
    confirmedAt: tstz('confirmed_at').notNull().defaultNow(),
    revokedAt: tstz('revoked_at'),
    revokedBy: uuid('revoked_by').references(() => account.id),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('family_link_active_uniq')
      .on(t.parentId, t.studentId)
      .where(sql`${t.status} = 'active'`),
    index('family_link_student_idx').on(t.studentId, t.status),
  ],
);
export type FamilyLinkRow = typeof familyLink.$inferSelect;

/** Group (class) of one teacher (5.4.4). Archived, never deleted. */
export const studyGroup = pgTable(
  'study_group',
  {
    id: idColumn(),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => account.id),
    name: text('name').notNull(),
    subjectId: uuid('subject_id').references(() => subject.id),
    emoji: text('emoji'),
    defaultDurationMin: integer('default_duration_min'),
    telegramChatId: bigint('telegram_chat_id', { mode: 'number' }),
    archivedAt: tstz('archived_at'),
    ...timestamps(),
  },
  (t) => [index('study_group_teacher_idx').on(t.teacherId)],
);
export type StudyGroupRow = typeof studyGroup.$inferSelect;

export const groupMember = pgTable(
  'group_member',
  {
    id: idColumn(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => studyGroup.id),
    studentId: uuid('student_id')
      .notNull()
      .references(() => account.id),
    joinedAt: tstz('joined_at').notNull().defaultNow(),
    leftAt: tstz('left_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('group_member_active_uniq')
      .on(t.groupId, t.studentId)
      .where(sql`${t.leftAt} IS NULL`),
  ],
);
export type GroupMemberRow = typeof groupMember.$inferSelect;

export const LEAVE_STATUSES = ['pending', 'approved', 'declined', 'expired', 'cancelled'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

/** Student's request to leave a teacher awaiting a parent's decision (5.8.2). */
export const leaveRequest = pgTable(
  'leave_request',
  {
    id: idColumn(),
    teacherStudentId: uuid('teacher_student_id')
      .notNull()
      .references(() => teacherStudent.id),
    initiatedBy: uuid('initiated_by')
      .notNull()
      .references(() => account.id),
    reason: text('reason').notNull(),
    status: text('status', { enum: LEAVE_STATUSES }).notNull().default('pending'),
    decidedBy: uuid('decided_by').references(() => account.id),
    decisionComment: text('decision_comment'),
    decidedAt: tstz('decided_at'),
    expiresAt: tstz('expires_at').notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('leave_request_single_pending')
      .on(t.teacherStudentId)
      .where(sql`${t.status} = 'pending'`),
  ],
);
export type LeaveRequestRow = typeof leaveRequest.$inferSelect;

export const TEMPLATE_KINDS = ['cancel_reason', 'end_link'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/** Reusable reason texts of a teacher (5.7.2). */
export const messageTemplate = pgTable(
  'message_template',
  {
    id: idColumn(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => account.id),
    kind: text('kind', { enum: TEMPLATE_KINDS }).notNull().default('cancel_reason'),
    text: text('text').notNull(),
    position: integer('position').notNull().default(0),
    archivedAt: tstz('archived_at'),
    ...timestamps(),
  },
  (t) => [index('message_template_owner_idx').on(t.ownerId, t.kind, t.position)],
);
export type MessageTemplateRow = typeof messageTemplate.$inferSelect;
