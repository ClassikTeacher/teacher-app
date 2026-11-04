import { sql } from 'drizzle-orm';
import { boolean, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { idColumn, timestamps, tstz } from '@shared/db/columns.js';
import { account } from '@modules/identity/schema.js';
import { lesson } from '@modules/schedule/schema.js';

// M6-04 (migration 0020), E2-05 (migration 0021). SQL is the source of truth.

/** 5.14.2: the secret of a calendar subscription, stored hashed; re-issuing revokes the old row. */
export const icsFeed = pgTable(
  'ics_feed',
  {
    id: idColumn(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id),
    tokenHash: text('token_hash').notNull(),
    createdAt: tstz('created_at')
      .notNull()
      .default(sql`now()`),
    revokedAt: tstz('revoked_at'),
  },
  (t) => [
    uniqueIndex('ics_feed_token_hash_key').on(t.tokenHash),
    uniqueIndex('ics_feed_account_live_uniq')
      .on(t.accountId)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);
export type IcsFeedRow = typeof icsFeed.$inferSelect;

export const GOOGLE_CONNECTION_STATUSES = ['active', 'error', 'revoked'] as const;
export type GoogleConnectionStatus = (typeof GOOGLE_CONNECTION_STATUSES)[number];

/** 5.14.1: a teacher's Google account; tokens are sealed (10.1), one live row per account. */
export const googleCalendarConnection = pgTable(
  'google_calendar_connection',
  {
    id: idColumn(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id),
    status: text('status', { enum: GOOGLE_CONNECTION_STATUSES }).notNull().default('active'),
    googleEmail: text('google_email'),
    calendarId: text('calendar_id'),
    refreshTokenEnc: text('refresh_token_enc').notNull(),
    accessTokenEnc: text('access_token_enc'),
    accessTokenExpiresAt: tstz('access_token_expires_at'),
    busyCalendarIds: text('busy_calendar_ids')
      .array()
      .notNull()
      .default(sql`'{primary}'::text[]`),
    importEnabled: boolean('import_enabled').notNull().default(true),
    exportEnabled: boolean('export_enabled').notNull().default(true),
    lastImportAt: tstz('last_import_at'),
    lastExportAt: tstz('last_export_at'),
    exportRequestedAt: tstz('export_requested_at'),
    lastError: text('last_error'),
    ...timestamps(),
    revokedAt: tstz('revoked_at'),
  },
  (t) => [
    uniqueIndex('google_calendar_connection_live_uniq')
      .on(t.accountId)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);
export type GoogleConnectionRow = typeof googleCalendarConnection.$inferSelect;

/** Lesson ⇄ Google event of a connection; the signature of the last write makes the export idempotent. */
export const googleCalendarEvent = pgTable(
  'google_calendar_event',
  {
    id: idColumn(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => googleCalendarConnection.id),
    lessonId: uuid('lesson_id')
      .notNull()
      .references(() => lesson.id),
    googleEventId: text('google_event_id').notNull(),
    signature: text('signature').notNull(),
    syncedAt: tstz('synced_at')
      .notNull()
      .default(sql`now()`),
    deletedAt: tstz('deleted_at'),
  },
  (t) => [unique('google_calendar_event_connection_id_lesson_id_key').on(t.connectionId, t.lessonId)],
);
export type GoogleEventRow = typeof googleCalendarEvent.$inferSelect;

/** One-time OAuth `state`, hashed and bound to the account that started the consent flow. */
export const googleOauthState = pgTable('google_oauth_state', {
  id: idColumn(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => account.id),
  stateHash: text('state_hash').notNull().unique(),
  expiresAt: tstz('expires_at').notNull(),
  usedAt: tstz('used_at'),
  createdAt: tstz('created_at')
    .notNull()
    .default(sql`now()`),
});
export type GoogleOauthStateRow = typeof googleOauthState.$inferSelect;
