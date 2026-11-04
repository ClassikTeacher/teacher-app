import { sql } from 'drizzle-orm';
import { timestamp, uuid } from 'drizzle-orm/pg-core';

/** Shared column helpers so every table follows the same conventions (UUID v7 ids, UTC timestamps). */
export const idColumn = () => uuid('id').primaryKey();

export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const timestamps = () => ({
  createdAt: tstz('created_at')
    .notNull()
    .default(sql`now()`),
  updatedAt: tstz('updated_at')
    .notNull()
    .default(sql`now()`),
});
