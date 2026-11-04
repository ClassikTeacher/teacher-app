import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { idColumn, timestamps, tstz } from '@shared/db/columns.js';

export const ACCOUNT_STATUSES = ['invited', 'onboarding', 'active', 'blocked'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const ROLES = ['SUPER_ADMIN', 'ADMIN', 'TEACHER', 'STUDENT', 'PARENT'] as const;
export type Role = (typeof ROLES)[number];

export const BOTS = ['auth', 'staff', 'student', 'parent'] as const;
export type Bot = (typeof BOTS)[number];

// NOTE: the SQL in migrations/ is the source of truth; keep this file in sync (CHECKs live only in SQL).
export const account = pgTable(
  'account',
  {
    id: idColumn(),
    telegramUserId: bigint('telegram_user_id', { mode: 'number' }).notNull(),
    firstName: text('first_name').notNull().default(''),
    lastName: text('last_name').notNull().default(''),
    username: text('username'),
    timezone: text('timezone').notNull().default('Europe/Minsk'),
    locale: text('locale').notNull().default('ru'),
    status: text('status', { enum: ACCOUNT_STATUSES }).notNull().default('onboarding'),
    priorStatus: text('prior_status', { enum: ['invited', 'onboarding', 'active'] }),
    blockedAt: tstz('blocked_at'),
    blockedBy: uuid('blocked_by'),
    blockReason: text('block_reason'),
    ...timestamps(),
  },
  (t) => [
    unique('account_telegram_user_id_key').on(t.telegramUserId),
    index('account_status_idx').on(t.status),
    index('account_username_idx')
      .on(sql`lower(${t.username})`)
      .where(sql`${t.username} IS NOT NULL`),
  ],
);

export const accountRole = pgTable(
  'account_role',
  {
    id: idColumn(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id),
    role: text('role', { enum: ROLES }).notNull(),
    grantedBy: uuid('granted_by').references(() => account.id),
    grantedAt: tstz('granted_at').notNull().defaultNow(),
    revokedAt: tstz('revoked_at'),
    revokedBy: uuid('revoked_by').references(() => account.id),
  },
  (t) => [
    index('account_role_account_idx').on(t.accountId),
    uniqueIndex('account_role_active_uniq')
      .on(t.accountId, t.role)
      .where(sql`${t.revokedAt} IS NULL`),
    uniqueIndex('account_role_single_super_admin')
      .on(t.role)
      .where(sql`${t.role} = 'SUPER_ADMIN' AND ${t.revokedAt} IS NULL`),
  ],
);

export const botChat = pgTable(
  'bot_chat',
  {
    id: idColumn(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id),
    bot: text('bot', { enum: BOTS }).notNull(),
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    isReachable: boolean('is_reachable').notNull().default(true),
    lastError: text('last_error'),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [unique('bot_chat_account_id_bot_key').on(t.accountId, t.bot)],
);

export const consent = pgTable(
  'consent',
  {
    id: idColumn(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id),
    document: text('document').notNull(),
    version: text('version').notNull(),
    acceptedAt: tstz('accepted_at').notNull().defaultNow(),
    onBehalfOf: uuid('on_behalf_of').references(() => account.id),
    source: text('source', { enum: ['bot', 'web', 'api', 'system'] })
      .notNull()
      .default('bot'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [index('consent_account_idx').on(t.accountId, t.document)],
);

export type AccountRow = typeof account.$inferSelect;
export type AccountInsert = typeof account.$inferInsert;
export type AccountRoleRow = typeof accountRole.$inferSelect;
export type BotChatRow = typeof botChat.$inferSelect;
export type ConsentRow = typeof consent.$inferSelect;

export const INVITATION_KINDS = ['bootstrap', 'teacher', 'admin', 'student', 'parent'] as const;
export type InvitationKind = (typeof INVITATION_KINDS)[number];

export const INVITATION_STATUSES = ['pending', 'used', 'revoked', 'expired'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export interface InvitationPayload {
  /** Display name typed by the inviter (teacher/admin/student invitations). */
  displayName?: string;
  /** Student invitation: subject and weekly limit (PPL-06); parent invitation: the child. */
  subjectId?: string;
  maxLessonsPerWeek?: number | null;
  grade?: string;
  teacherId?: string;
  studentId?: string;
  /** Pre-created teacher_student link (student invitation) — filled in M2-02. */
  linkId?: string;
}

export const invitation = pgTable(
  'invitation',
  {
    id: idColumn(),
    tokenHash: text('token_hash').notNull(),
    kind: text('kind', { enum: INVITATION_KINDS }).notNull(),
    createdBy: uuid('created_by').references(() => account.id),
    targetTelegramUserId: bigint('target_telegram_user_id', { mode: 'number' }),
    payload: jsonb('payload').$type<InvitationPayload>().notNull().default({}),
    maxUses: integer('max_uses').notNull().default(1),
    usedCount: integer('used_count').notNull().default(0),
    expiresAt: tstz('expires_at').notNull(),
    status: text('status', { enum: INVITATION_STATUSES }).notNull().default('pending'),
    usedBy: uuid('used_by').references(() => account.id),
    usedAt: tstz('used_at'),
    revokedBy: uuid('revoked_by').references(() => account.id),
    revokedAt: tstz('revoked_at'),
    ...timestamps(),
  },
  (t) => [
    unique('invitation_token_hash_key').on(t.tokenHash),
    index('invitation_pending_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'pending'`),
    index('invitation_created_by_idx').on(t.createdBy, t.createdAt),
  ],
);

export type InvitationRow = typeof invitation.$inferSelect;

export const TRANSFER_STATUSES = ['pending', 'confirmed', 'declined', 'expired', 'cancelled'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

/** Super admin transfer requested through the system API and confirmed in AuthBot (5.3.4, UC-02). */
export const superAdminTransfer = pgTable(
  'super_admin_transfer',
  {
    id: idColumn(),
    fromAccountId: uuid('from_account_id')
      .notNull()
      .references(() => account.id),
    toAccountId: uuid('to_account_id')
      .notNull()
      .references(() => account.id),
    previousRole: text('previous_role', { enum: ['ADMIN', 'NONE'] }).notNull(),
    status: text('status', { enum: TRANSFER_STATUSES }).notNull().default('pending'),
    expiresAt: tstz('expires_at').notNull(),
    decidedAt: tstz('decided_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('super_admin_transfer_single_pending')
      .on(t.status)
      .where(sql`${t.status} = 'pending'`),
  ],
);

export type SuperAdminTransferRow = typeof superAdminTransfer.$inferSelect;
