import { sql } from 'drizzle-orm';
import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { idColumn, tstz } from '@shared/db/columns.js';
import { account } from '@modules/identity/schema.js';

// M6-04 (migration 0020). SQL is the source of truth.

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
