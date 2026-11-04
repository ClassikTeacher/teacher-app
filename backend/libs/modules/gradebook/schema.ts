import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { idColumn, timestamps, tstz } from '@shared/db/columns.js';
import { account } from '@modules/identity/schema.js';
import { subject, teacherStudent } from '@modules/people/schema.js';

// M6-01/M6-02 (migration 0018). SQL is the source of truth; CHECKs live only there.

/** The platform 10-point scale (Р-10), seeded by migration 0018. */
export const PLATFORM_SCALE_ID = '019a0000-0000-7000-8000-0000000000a1';

export const SCALE_KINDS = ['numeric', 'custom'] as const;
export type ScaleKind = (typeof SCALE_KINDS)[number];

export const gradeScale = pgTable('grade_scale', {
  id: idColumn(),
  ownerId: uuid('owner_id').references(() => account.id),
  kind: text('kind', { enum: SCALE_KINDS }).notNull(),
  title: text('title').notNull(),
  minValue: integer('min_value'),
  maxValue: integer('max_value'),
  archivedAt: tstz('archived_at'),
  ...timestamps(),
});
export type GradeScaleRow = typeof gradeScale.$inferSelect;

export const gradeScaleValue = pgTable(
  'grade_scale_value',
  {
    id: idColumn(),
    scaleId: uuid('scale_id')
      .notNull()
      .references(() => gradeScale.id),
    label: text('label').notNull(),
    emoji: text('emoji'),
    position: integer('position').notNull().default(0),
    weight: numeric('weight', { precision: 6, scale: 2, mode: 'number' }),
    archivedAt: tstz('archived_at'),
    ...timestamps(),
  },
  (t) => [index('grade_scale_value_scale_idx').on(t.scaleId, t.position)],
);
export type GradeScaleValueRow = typeof gradeScaleValue.$inferSelect;
export type GradeScaleValueInsert = typeof gradeScaleValue.$inferInsert;

export const testKind = pgTable(
  'test_kind',
  {
    id: idColumn(),
    ownerId: uuid('owner_id').references(() => account.id),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    archivedAt: tstz('archived_at'),
    createdAt: tstz('created_at')
      .notNull()
      .default(sql`now()`),
  },
  (t) => [uniqueIndex('test_kind_owner_name_uniq').on(t.ownerId, sql`lower(${t.name})`)],
);
export type TestKindRow = typeof testKind.$inferSelect;

export const JOURNAL_TYPES = ['school', 'tests', 'custom'] as const;
export type JournalType = (typeof JOURNAL_TYPES)[number];

export const journal = pgTable(
  'journal',
  {
    id: idColumn(),
    teacherStudentId: uuid('teacher_student_id')
      .notNull()
      .references(() => teacherStudent.id),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => account.id),
    studentId: uuid('student_id')
      .notNull()
      .references(() => account.id),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subject.id),
    type: text('type', { enum: JOURNAL_TYPES }).notNull(),
    visibleToStudent: boolean('visible_to_student').notNull().default(true),
    visibleToParent: boolean('visible_to_parent').notNull().default(true),
    hidden: boolean('hidden').notNull().default(false),
    targetScore: numeric('target_score', { precision: 6, scale: 2, mode: 'number' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('journal_teacher_student_id_subject_id_type_key').on(t.teacherStudentId, t.subjectId, t.type),
    index('journal_teacher_student_idx').on(t.teacherId, t.studentId),
    index('journal_student_idx').on(t.studentId),
  ],
);
export type JournalRow = typeof journal.$inferSelect;
export type JournalInsert = typeof journal.$inferInsert;

export const SCHOOL_CATEGORIES = ['current', 'independent', 'control', 'exam', 'quarter', 'year'] as const;
export type SchoolCategory = (typeof SCHOOL_CATEGORIES)[number];
export const ENTRY_SOURCES = ['teacher', 'student', 'parent'] as const;
export type EntrySource = (typeof ENTRY_SOURCES)[number];
export const ENTRY_STATUSES = ['confirmed', 'pending', 'rejected'] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

/** Test score breakdown 💡 (5.11.3): points per part. */
export interface TestParts {
  a?: number;
  b?: number;
}

export const gradeEntry = pgTable(
  'grade_entry',
  {
    id: idColumn(),
    journalId: uuid('journal_id')
      .notNull()
      .references(() => journal.id),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => account.id),
    studentId: uuid('student_id')
      .notNull()
      .references(() => account.id),
    /** ISO date `YYYY-MM-DD` (a calendar date, no zone). */
    date: date('date').notNull(),
    category: text('category', { enum: SCHOOL_CATEGORIES }),
    testKindId: uuid('test_kind_id').references(() => testKind.id),
    valueNumeric: numeric('value_numeric', { precision: 6, scale: 2, mode: 'number' }),
    valueMax: numeric('value_max', { precision: 6, scale: 2, mode: 'number' }),
    scaleValueId: uuid('scale_value_id').references(() => gradeScaleValue.id),
    parts: jsonb('parts').$type<TestParts>(),
    weight: numeric('weight', { precision: 6, scale: 2, mode: 'number' }).notNull().default(1),
    comment: text('comment'),
    lessonId: uuid('lesson_id'),
    assignmentId: uuid('assignment_id'),
    /** Tests: the scanned answer sheet (5.11.3); the file module owns the row. */
    fileId: uuid('file_id'),
    source: text('source', { enum: ENTRY_SOURCES }).notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => account.id),
    status: text('status', { enum: ENTRY_STATUSES }).notNull().default('confirmed'),
    version: integer('version').notNull().default(1),
    deletedAt: tstz('deleted_at'),
    ...timestamps(),
  },
  (t) => [
    index('grade_entry_journal_idx')
      .on(t.journalId, t.date, t.createdAt)
      .where(sql`${t.deletedAt} IS NULL`),
    index('grade_entry_pending_idx')
      .on(t.teacherId, t.createdAt)
      .where(sql`${t.status} = 'pending' AND ${t.deletedAt} IS NULL`),
  ],
);
export type GradeEntryRow = typeof gradeEntry.$inferSelect;
export type GradeEntryInsert = typeof gradeEntry.$inferInsert;

export const HISTORY_ACTIONS = ['created', 'updated', 'deleted', 'confirmed', 'rejected'] as const;
export type HistoryAction = (typeof HISTORY_ACTIONS)[number];

export const gradeEntryHistory = pgTable(
  'grade_entry_history',
  {
    id: idColumn(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => gradeEntry.id),
    changedBy: uuid('changed_by').references(() => account.id),
    action: text('action', { enum: HISTORY_ACTIONS }).notNull(),
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
    at: tstz('at')
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('grade_entry_history_entry_idx').on(t.entryId, t.at)],
);
export type GradeEntryHistoryRow = typeof gradeEntryHistory.$inferSelect;
