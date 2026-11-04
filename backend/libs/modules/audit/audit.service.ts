import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lt, type SQL } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import { currentCorrelation } from '@shared/logging/correlation.js';
import { auditLog, type AuditLogRow, type AuditSource } from './schema.js';

const SYSTEM_ACTOR_ID = '00000000-0000-7000-8000-000000000000';

export interface AuditEntry {
  actorId: string | null;
  actorRole?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  source: AuditSource;
  ip?: string | null;
}

export interface AuditQuery {
  actorId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  from?: Date;
  to?: Date;
  page: number;
  limit: number;
}

/** Append-only audit trail (AUD-01). Written inside the caller's transaction so it never diverges from the change. */
@Injectable()
export class AuditService {
  constructor(private readonly txm: TransactionManager) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.txm.db.insert(auditLog).values({
      id: newId(),
      // The system actor is not an account row; keep the FK happy and mark the source instead.
      actorId: entry.actorId === SYSTEM_ACTOR_ID ? null : entry.actorId,
      actorRole: entry.actorRole ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      source: entry.source,
      ip: entry.ip ?? null,
      correlationId: currentCorrelation()?.correlationId ?? null,
    });
  }

  async query(q: AuditQuery): Promise<{ items: AuditLogRow[]; total: number }> {
    const filters: SQL[] = [];
    if (q.actorId) filters.push(eq(auditLog.actorId, q.actorId));
    if (q.entityType) filters.push(eq(auditLog.entityType, q.entityType));
    if (q.entityId) filters.push(eq(auditLog.entityId, q.entityId));
    if (q.action) filters.push(eq(auditLog.action, q.action));
    if (q.from) filters.push(gte(auditLog.at, q.from));
    if (q.to) filters.push(lt(auditLog.at, q.to));
    const where = filters.length > 0 ? and(...filters) : undefined;
    const items = await this.txm.db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.at), desc(auditLog.id))
      .limit(q.limit)
      .offset((q.page - 1) * q.limit);
    const total = await this.txm.db.$count(auditLog, where);
    return { items, total };
  }
}
