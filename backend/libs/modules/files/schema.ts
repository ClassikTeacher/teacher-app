import { sql } from 'drizzle-orm';
import { bigint, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { idColumn, timestamps, tstz } from '@shared/db/columns.js';
import { account, type Bot } from '@modules/identity/schema.js';
import { fileType } from '@modules/people/file-type.repository.js';

// M5-01 (migration 0015). SQL is the source of truth; CHECKs live only there.

export const SCAN_STATUSES = ['pending', 'clean', 'infected', 'skipped'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];
export const FILE_STATUSES = ['draft', 'attached', 'deleted'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

export const file = pgTable(
  'file',
  {
    id: idColumn(),
    bucket: text('bucket').notNull(),
    key: text('key').notNull(),
    originalName: text('original_name').notNull(),
    ext: text('ext')
      .notNull()
      .references(() => fileType.ext),
    mime: text('mime').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    scanStatus: text('scan_status', { enum: SCAN_STATUSES }).notNull().default('pending'),
    scanError: text('scan_error'),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => account.id),
    ownerTeacherId: uuid('owner_teacher_id')
      .notNull()
      .references(() => account.id),
    status: text('status', { enum: FILE_STATUSES }).notNull().default('draft'),
    attachedAt: tstz('attached_at'),
    deletedAt: tstz('deleted_at'),
    ...timestamps(),
  },
  (t) => [
    unique('file_bucket_key_key').on(t.bucket, t.key),
    index('file_owner_idx')
      .on(t.ownerTeacherId)
      .where(sql`${t.status} <> 'deleted'`),
  ],
);
export type FileRow = typeof file.$inferSelect;
export type FileInsert = typeof file.$inferInsert;

export const telegramFileCache = pgTable(
  'telegram_file_cache',
  {
    id: idColumn(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => file.id, { onDelete: 'cascade' }),
    bot: text('bot').$type<Bot>().notNull(),
    telegramFileId: text('telegram_file_id').notNull(),
    telegramFileUniqueId: text('telegram_file_unique_id').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [unique('telegram_file_cache_file_id_bot_key').on(t.fileId, t.bot)],
);
export type TelegramFileCacheRow = typeof telegramFileCache.$inferSelect;

export const storageUsage = pgTable('storage_usage', {
  teacherId: uuid('teacher_id')
    .primaryKey()
    .references(() => account.id),
  usedBytes: bigint('used_bytes', { mode: 'number' }).notNull().default(0),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});
export type StorageUsageRow = typeof storageUsage.$inferSelect;
