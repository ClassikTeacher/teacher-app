import { index, inet, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { idColumn, tstz } from '@shared/db/columns.js';

export const AUDIT_SOURCES = ['bot', 'web', 'api', 'system'] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];

export const auditLog = pgTable(
  'audit_log',
  {
    id: idColumn(),
    actorId: uuid('actor_id'),
    actorRole: text('actor_role'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    before: jsonb('before').$type<Record<string, unknown> | null>(),
    after: jsonb('after').$type<Record<string, unknown> | null>(),
    source: text('source', { enum: AUDIT_SOURCES }).notNull(),
    ip: inet('ip'),
    correlationId: text('correlation_id'),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [index('audit_log_at_idx').on(t.at), index('audit_log_entity_idx').on(t.entityType, t.entityId)],
);

export type AuditLogRow = typeof auditLog.$inferSelect;
