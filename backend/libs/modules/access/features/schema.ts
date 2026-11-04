import { boolean, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps } from '@shared/db/columns.js';
import { account } from '@modules/identity/schema.js';
import type { FeatureLimits } from './catalog.js';

export const feature = pgTable('feature', {
  key: text('key').primaryKey(),
  globalEnabled: boolean('global_enabled').notNull().default(true),
  defaultEnabled: boolean('default_enabled').notNull(),
  defaultLimits: jsonb('default_limits').$type<FeatureLimits>().notNull().default({}),
  updatedBy: uuid('updated_by').references(() => account.id),
  ...timestamps(),
});

export const accountFeature = pgTable(
  'account_feature',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id),
    featureKey: text('feature_key')
      .notNull()
      .references(() => feature.key),
    enabled: boolean('enabled'),
    limits: jsonb('limits').$type<FeatureLimits>(),
    updatedBy: uuid('updated_by').references(() => account.id),
    ...timestamps(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.featureKey] })],
);

export type FeatureRow = typeof feature.$inferSelect;
export type AccountFeatureRow = typeof accountFeature.$inferSelect;
