import { date, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { idColumn, timestamps, tstz } from '@shared/db/columns.js';
import { file } from '@modules/files/schema.js';
import { account } from '@modules/identity/schema.js';
import { subject } from '@modules/people/schema.js';
import { lesson } from '@modules/schedule/schema.js';

// M5-02 (migration 0016). SQL is the source of truth; CHECKs live only there.

export const MATERIAL_KINDS = ['file', 'link', 'text'] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];

export const material = pgTable('material', {
  id: idColumn(),
  teacherId: uuid('teacher_id')
    .notNull()
    .references(() => account.id),
  kind: text('kind', { enum: MATERIAL_KINDS }).notNull(),
  title: text('title').notNull(),
  description: text('description'),
  fileId: uuid('file_id').references(() => file.id),
  url: text('url'),
  body: text('body'),
  subjectId: uuid('subject_id').references(() => subject.id),
  tags: text('tags').array().notNull().default([]),
  archivedAt: tstz('archived_at'),
  ...timestamps(),
});
export type MaterialRow = typeof material.$inferSelect;
export type MaterialInsert = typeof material.$inferInsert;

export const collection = pgTable('collection', {
  id: idColumn(),
  teacherId: uuid('teacher_id')
    .notNull()
    .references(() => account.id),
  title: text('title').notNull(),
  description: text('description'),
  /** ISO dates `YYYY-MM-DD`. */
  periodFrom: date('period_from'),
  periodTo: date('period_to'),
  archivedAt: tstz('archived_at'),
  ...timestamps(),
});
export type CollectionRow = typeof collection.$inferSelect;
export type CollectionInsert = typeof collection.$inferInsert;

export const COLLECTION_ITEM_TYPES = ['material', 'assignment'] as const;
export type CollectionItemType = (typeof COLLECTION_ITEM_TYPES)[number];

export const collectionItem = pgTable(
  'collection_item',
  {
    id: idColumn(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collection.id),
    itemType: text('item_type', { enum: COLLECTION_ITEM_TYPES }).notNull(),
    itemId: uuid('item_id').notNull(),
    position: integer('position').notNull().default(0),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('collection_item_collection_id_item_type_item_id_key').on(t.collectionId, t.itemType, t.itemId),
  ],
);
export type CollectionItemRow = typeof collectionItem.$inferSelect;

export const RELEASES = ['before', 'after'] as const;
export type Release = (typeof RELEASES)[number];

export const lessonMaterial = pgTable('lesson_material', {
  id: idColumn(),
  lessonId: uuid('lesson_id')
    .notNull()
    .references(() => lesson.id),
  materialId: uuid('material_id').references(() => material.id),
  collectionId: uuid('collection_id').references(() => collection.id),
  release: text('release', { enum: RELEASES }).notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
});
export type LessonMaterialRow = typeof lessonMaterial.$inferSelect;

export const GRANT_SUBJECTS = ['material', 'collection', 'assignment'] as const;
export type GrantSubjectType = (typeof GRANT_SUBJECTS)[number];
export const GRANTEE_TYPES = ['student', 'group'] as const;
export type GranteeType = (typeof GRANTEE_TYPES)[number];

export const accessGrant = pgTable('access_grant', {
  id: idColumn(),
  teacherId: uuid('teacher_id')
    .notNull()
    .references(() => account.id),
  subjectType: text('subject_type', { enum: GRANT_SUBJECTS }).notNull(),
  subjectId: uuid('subject_id').notNull(),
  granteeType: text('grantee_type', { enum: GRANTEE_TYPES }).notNull(),
  granteeId: uuid('grantee_id').notNull(),
  availableFrom: tstz('available_from'),
  availableUntil: tstz('available_until'),
  grantedBy: uuid('granted_by').references(() => account.id),
  sourceLessonId: uuid('source_lesson_id').references(() => lesson.id),
  revokedAt: tstz('revoked_at'),
  createdAt: tstz('created_at').notNull().defaultNow(),
});
export type AccessGrantRow = typeof accessGrant.$inferSelect;
export type AccessGrantInsert = typeof accessGrant.$inferInsert;

export const materialView = pgTable(
  'material_view',
  {
    id: idColumn(),
    materialId: uuid('material_id')
      .notNull()
      .references(() => material.id),
    studentId: uuid('student_id')
      .notNull()
      .references(() => account.id),
    firstViewedAt: tstz('first_viewed_at').notNull(),
    lastViewedAt: tstz('last_viewed_at').notNull(),
  },
  (t) => [unique('material_view_material_id_student_id_key').on(t.materialId, t.studentId)],
);
export type MaterialViewRow = typeof materialView.$inferSelect;
