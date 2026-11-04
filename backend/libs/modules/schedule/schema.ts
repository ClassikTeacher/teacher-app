import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  time,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { DateTime } from 'luxon';
import { idColumn, timestamps, tstz } from '@shared/db/columns.js';
import { account } from '@modules/identity/schema.js';
import { studyGroup, subject } from '@modules/people/schema.js';

// M3 (migration 0011). SQL is the source of truth; CHECKs live only there.

/** Half-open interval `[start, end)` (CAL-03). */
export interface Interval {
  start: Date;
  end: Date;
}

function parseBound(raw: string): Date {
  const parsed = DateTime.fromSQL(raw.replace(/^"|"$/g, ''), { setZone: true });
  if (!parsed.isValid) throw new Error(`invalid tstzrange bound: ${raw}`);
  return parsed.toJSDate();
}

/** `tstzrange` ⇄ Interval; only `[start, end)` ranges are written (the CHECK in SQL enforces the same). */
export const tstzrange = customType<{ data: Interval; driverData: string }>({
  dataType: () => 'tstzrange',
  toDriver: (value) => `[${value.start.toISOString()},${value.end.toISOString()})`,
  fromDriver: (value) => {
    const match = /^[[(]("?[^",]*"?),("?[^",)\]]*"?)[)\]]$/.exec(value);
    if (!match) throw new Error(`cannot parse tstzrange: ${value}`);
    return { start: parseBound(match[1]!), end: parseBound(match[2]!) };
  },
});

export const personalBlock = pgTable(
  'personal_block',
  {
    id: idColumn(),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => account.id),
    startsAt: tstz('starts_at').notNull(),
    endsAt: tstz('ends_at').notNull(),
    title: text('title'),
    removedAt: tstz('removed_at'),
    ...timestamps(),
  },
  (t) => [
    index('personal_block_teacher_idx')
      .on(t.teacherId, t.startsAt)
      .where(sql`${t.removedAt} IS NULL`),
  ],
);
export type PersonalBlockRow = typeof personalBlock.$inferSelect;

export const LESSON_FORMATS = ['online', 'in_person', 'at_student'] as const;
export type LessonFormat = (typeof LESSON_FORMATS)[number];
export const SERIES_STATUSES = ['active', 'ended'] as const;
export type SeriesStatus = (typeof SERIES_STATUSES)[number];

export const lessonSeries = pgTable(
  'lesson_series',
  {
    id: idColumn(),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => account.id),
    studentId: uuid('student_id').references(() => account.id),
    groupId: uuid('group_id').references(() => studyGroup.id),
    rrule: text('rrule').notNull(),
    /** `HH:MM:SS` in the teacher's zone. */
    startLocal: time('start_local').notNull(),
    durationMin: integer('duration_min').notNull(),
    timezone: text('timezone').notNull(),
    /** ISO dates `YYYY-MM-DD` in the teacher's zone. */
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on'),
    pausedFrom: date('paused_from'),
    pausedTo: date('paused_to'),
    materializedUntil: date('materialized_until'),
    subjectId: uuid('subject_id').references(() => subject.id),
    format: text('format', { enum: LESSON_FORMATS }),
    location: text('location'),
    meetingUrl: text('meeting_url'),
    status: text('status', { enum: SERIES_STATUSES }).notNull().default('active'),
    ...timestamps(),
  },
  (t) => [
    index('lesson_series_teacher_idx')
      .on(t.teacherId)
      .where(sql`${t.status} = 'active'`),
  ],
);
export type LessonSeriesRow = typeof lessonSeries.$inferSelect;
export type LessonSeriesInsert = typeof lessonSeries.$inferInsert;

export const LESSON_STATUSES = [
  'scheduled',
  'cancelled',
  'awaiting_report',
  'completed',
  'not_held',
] as const;
export type LessonStatus = (typeof LESSON_STATUSES)[number];
export const CREATED_VIA = ['teacher', 'student_booking', 'series', 'booking_accepted'] as const;
export type CreatedVia = (typeof CREATED_VIA)[number];

export const lesson = pgTable(
  'lesson',
  {
    id: idColumn(),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => account.id),
    groupId: uuid('group_id').references(() => studyGroup.id),
    seriesId: uuid('series_id').references(() => lessonSeries.id),
    startsAt: tstz('starts_at').notNull(),
    endsAt: tstz('ends_at').notNull(),
    status: text('status', { enum: LESSON_STATUSES }).notNull().default('scheduled'),
    subjectId: uuid('subject_id').references(() => subject.id),
    plannedTopic: text('planned_topic'),
    topic: text('topic'),
    format: text('format', { enum: LESSON_FORMATS }),
    location: text('location'),
    meetingUrl: text('meeting_url'),
    sharedComment: text('shared_comment'),
    teacherNotes: text('teacher_notes'),
    seqNo: integer('seq_no'),
    notHeldReason: text('not_held_reason'),
    reportedAt: tstz('reported_at'),
    outsideWindows: boolean('outside_windows').notNull().default(false),
    createdBy: uuid('created_by').references(() => account.id),
    createdVia: text('created_via', { enum: CREATED_VIA }).notNull().default('teacher'),
    cancelledAt: tstz('cancelled_at'),
    cancellationId: uuid('cancellation_id'),
    version: integer('version').notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    index('lesson_teacher_time_idx').on(t.teacherId, t.startsAt),
    index('lesson_scheduled_end_idx')
      .on(t.endsAt)
      .where(sql`${t.status} = 'scheduled'`),
  ],
);
export type LessonRow = typeof lesson.$inferSelect;
export type LessonInsert = typeof lesson.$inferInsert;

export const ATTENDANCE = ['present', 'late', 'absent_notified', 'absent'] as const;
export type Attendance = (typeof ATTENDANCE)[number];

export const lessonParticipant = pgTable(
  'lesson_participant',
  {
    id: idColumn(),
    lessonId: uuid('lesson_id')
      .notNull()
      .references(() => lesson.id),
    studentId: uuid('student_id')
      .notNull()
      .references(() => account.id),
    attendance: text('attendance', { enum: ATTENDANCE }),
    absenceReason: text('absence_reason'),
    addedAt: tstz('added_at').notNull().defaultNow(),
    removedAt: tstz('removed_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('lesson_participant_active_uniq')
      .on(t.lessonId, t.studentId)
      .where(sql`${t.removedAt} IS NULL`),
  ],
);
export type LessonParticipantRow = typeof lessonParticipant.$inferSelect;

export const OCCUPANCY_KINDS = ['lesson', 'block'] as const;
export type OccupancyKind = (typeof OCCUPANCY_KINDS)[number];

/** See 7.5: one row per person and source; `occupancy_no_overlap` (EXCLUDE) guards CAL-01. */
export const occupancy = pgTable(
  'occupancy',
  {
    id: idColumn(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id),
    kind: text('kind', { enum: OCCUPANCY_KINDS }).notNull(),
    lessonId: uuid('lesson_id').references(() => lesson.id),
    blockId: uuid('block_id').references(() => personalBlock.id),
    during: tstzrange('during').notNull(),
    bufferBeforeMin: integer('buffer_before_min').notNull().default(0),
    bufferAfterMin: integer('buffer_after_min').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    index('occupancy_lesson_idx')
      .on(t.lessonId)
      .where(sql`${t.lessonId} IS NOT NULL`),
  ],
);
export type OccupancyRow = typeof occupancy.$inferSelect;

export const lessonEvent = pgTable(
  'lesson_event',
  {
    id: idColumn(),
    lessonId: uuid('lesson_id')
      .notNull()
      .references(() => lesson.id),
    type: text('type').notNull(),
    actorId: uuid('actor_id').references(() => account.id),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [index('lesson_event_lesson_idx').on(t.lessonId, t.at)],
);
export type LessonEventRow = typeof lessonEvent.$inferSelect;

export const availabilityRule = pgTable(
  'availability_rule',
  {
    id: idColumn(),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => account.id),
    /** ISO weekday: 1 = Monday … 7 = Sunday. */
    weekday: integer('weekday').notNull(),
    startLocal: time('start_local').notNull(),
    endLocal: time('end_local').notNull(),
    validFrom: date('valid_from'),
    validTo: date('valid_to'),
    removedAt: tstz('removed_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('availability_rule_teacher_idx')
      .on(t.teacherId, t.weekday)
      .where(sql`${t.removedAt} IS NULL`),
  ],
);
export type AvailabilityRuleRow = typeof availabilityRule.$inferSelect;

export const EXCEPTION_KINDS = ['closed', 'extra'] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export const availabilityException = pgTable(
  'availability_exception',
  {
    id: idColumn(),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => account.id),
    date: date('date').notNull(),
    startLocal: time('start_local'),
    endLocal: time('end_local'),
    kind: text('kind', { enum: EXCEPTION_KINDS }).notNull(),
    removedAt: tstz('removed_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('availability_exception_teacher_idx')
      .on(t.teacherId, t.date)
      .where(sql`${t.removedAt} IS NULL`),
  ],
);
export type AvailabilityExceptionRow = typeof availabilityException.$inferSelect;

// M4-01 (migration 0012): cancellations (5.7, CNL-08).

export const CANCEL_ROLES = ['TEACHER', 'STUDENT', 'PARENT', 'ADMIN', 'SYSTEM'] as const;
export type CancelRole = (typeof CANCEL_ROLES)[number];
export const CANCELLATION_KINDS = ['single', 'bulk', 'system'] as const;
export type CancellationKind = (typeof CANCELLATION_KINDS)[number];
export const CANCEL_ACTIONS = ['cancelled', 'absence'] as const;
export type CancelAction = (typeof CANCEL_ACTIONS)[number];

/** One act of cancelling: who, in which role, why; a bulk act (5.7.5) holds many items. */
export const cancellation = pgTable('cancellation', {
  id: idColumn(),
  initiatorId: uuid('initiator_id').references(() => account.id),
  initiatorRole: text('initiator_role', { enum: CANCEL_ROLES }).notNull(),
  onBehalfOfStudentId: uuid('on_behalf_of_student_id').references(() => account.id),
  kind: text('kind', { enum: CANCELLATION_KINDS }).notNull(),
  reason: text('reason').notNull(),
  templateId: uuid('template_id'),
  source: text('source'),
  createdAt: tstz('created_at').notNull().defaultNow(),
});
export type CancellationRow = typeof cancellation.$inferSelect;

export const cancellationItem = pgTable(
  'cancellation_item',
  {
    id: idColumn(),
    cancellationId: uuid('cancellation_id')
      .notNull()
      .references(() => cancellation.id),
    lessonId: uuid('lesson_id')
      .notNull()
      .references(() => lesson.id),
    action: text('action', { enum: CANCEL_ACTIONS }).notNull(),
    studentId: uuid('student_id').references(() => account.id),
    isLate: boolean('is_late').notNull().default(false),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [index('cancellation_item_batch_idx').on(t.cancellationId)],
);
export type CancellationItemRow = typeof cancellationItem.$inferSelect;

// M4-03 / M4-04 (migration 0013): requests (5.5.5, 5.7.4). A request never occupies time (Р-22, Р-24).

export const REQUEST_KINDS = ['booking', 'reschedule', 'reschedule_ask'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export const REQUEST_STATUSES = ['pending', 'accepted', 'declined', 'expired', 'cancelled'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const bookingRequest = pgTable(
  'booking_request',
  {
    id: idColumn(),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => account.id),
    studentId: uuid('student_id')
      .notNull()
      .references(() => account.id),
    kind: text('kind', { enum: REQUEST_KINDS }).notNull(),
    lessonId: uuid('lesson_id').references(() => lesson.id),
    startsAt: tstz('starts_at'),
    endsAt: tstz('ends_at'),
    comment: text('comment'),
    status: text('status', { enum: REQUEST_STATUSES }).notNull().default('pending'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => account.id),
    decidedBy: uuid('decided_by').references(() => account.id),
    decisionMessage: text('decision_message'),
    decisionReason: text('decision_reason'),
    decidedAt: tstz('decided_at'),
    ...timestamps(),
  },
  (t) => [
    index('booking_request_teacher_pending_idx')
      .on(t.teacherId, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);
export type BookingRequestRow = typeof bookingRequest.$inferSelect;

// E2-05 (migration 0021)

export const EXTERNAL_BUSY_SOURCES = ['google'] as const;
export type ExternalBusySource = (typeof EXTERNAL_BUSY_SOURCES)[number];

/** 5.5.2: busy time imported from an external calendar — a soft block of the teacher's time (8.2 `external_busy`). */
export const externalBusy = pgTable(
  'external_busy',
  {
    id: idColumn(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id),
    source: text('source', { enum: EXTERNAL_BUSY_SOURCES }).notNull(),
    during: tstzrange('during').notNull(),
    syncedAt: tstz('synced_at')
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('external_busy_account_idx').on(t.accountId, t.source)],
);
export type ExternalBusyRow = typeof externalBusy.$inferSelect;
