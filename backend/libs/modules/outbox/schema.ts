import { index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { idColumn, tstz } from '@shared/db/columns.js';

export const outboxEvent = pgTable(
  'outbox_event',
  {
    id: idColumn(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id'),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    correlationId: text('correlation_id'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    publishedAt: tstz('published_at'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [index('outbox_event_unpublished_idx').on(t.createdAt)],
);

export type OutboxEventRow = typeof outboxEvent.$inferSelect;
