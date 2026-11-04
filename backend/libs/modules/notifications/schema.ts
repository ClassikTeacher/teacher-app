import { boolean, index, integer, jsonb, pgTable, text, time, unique, uuid } from 'drizzle-orm/pg-core';
import { idColumn, timestamps, tstz } from '@shared/db/columns.js';
import { account, BOTS } from '@modules/identity/schema.js';

export const NOTIFICATION_STATUSES = [
  'scheduled',
  'queued',
  'sending',
  'sent',
  'failed',
  'skipped',
  'cancelled',
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const ROUTES = ['cc', 'via_parent'] as const;
export type NotificationRoute = (typeof ROUTES)[number];

export const notification = pgTable(
  'notification',
  {
    id: idColumn(),
    typeCode: text('type_code').notNull(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => account.id),
    bot: text('bot', { enum: BOTS }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    dedupeKey: text('dedupe_key').notNull(),
    dueAt: tstz('due_at').notNull(),
    status: text('status', { enum: NOTIFICATION_STATUSES }).notNull().default('scheduled'),
    attempts: integer('attempts').notNull().default(0),
    sentAt: tstz('sent_at'),
    error: text('error'),
    ccOfId: uuid('cc_of_id'),
    /** `cc` — a copy to a parent (NTF-03); `via_parent` — the parent stands in for an unreachable student (NTF-04). */
    route: text('route', { enum: ROUTES }),
    /** The student the copy or stand-in message is about. */
    forAccountId: uuid('for_account_id'),
    ...timestamps(),
  },
  (t) => [
    unique('notification_dedupe_key_key').on(t.dedupeKey),
    index('notification_recipient_idx').on(t.recipientId, t.createdAt),
  ],
);

export type NotificationRow = typeof notification.$inferSelect;

// M4-05 (migration 0014): preferences and per-type switches (5.13.2–5.13.4).

export const notificationProfile = pgTable('notification_profile', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => account.id),
  reminderOffsetsMin: integer('reminder_offsets_min').array().notNull().default([1440, 60]),
  quietEnabled: boolean('quiet_enabled').notNull().default(true),
  quietFrom: time('quiet_from').notNull().default('22:00'),
  quietTo: time('quiet_to').notNull().default('08:00'),
  digestEnabled: boolean('digest_enabled').notNull().default(true),
  digestTime: time('digest_time').notNull().default('08:00'),
  deliverViaParent: boolean('deliver_via_parent').notNull().default(false),
  ...timestamps(),
});
export type NotificationProfileRow = typeof notificationProfile.$inferSelect;

export const SETTING_KINDS = ['cc_default', 'cc_student', 'mute'] as const;
export type SettingKind = (typeof SETTING_KINDS)[number];

export const notificationSetting = pgTable('notification_setting', {
  id: idColumn(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => account.id),
  kind: text('kind', { enum: SETTING_KINDS }).notNull(),
  studentId: uuid('student_id').references(() => account.id),
  typeCode: text('type_code').notNull(),
  enabled: boolean('enabled').notNull(),
  ...timestamps(),
});
export type NotificationSettingRow = typeof notificationSetting.$inferSelect;
