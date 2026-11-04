import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { outboxEvent, type OutboxEventRow } from './schema.js';

@Injectable()
export class OutboxRepository {
  constructor(private readonly txm: TransactionManager) {}

  /** Oldest unpublished events, locked for this publisher run (`FOR UPDATE SKIP LOCKED`). */
  async lockUnpublished(limit: number): Promise<OutboxEventRow[]> {
    return this.txm.db
      .select()
      .from(outboxEvent)
      .where(isNull(outboxEvent.publishedAt))
      .orderBy(asc(outboxEvent.createdAt), asc(outboxEvent.id))
      .limit(limit)
      .for('update', { skipLocked: true });
  }

  async markPublished(ids: string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.txm.db.update(outboxEvent).set({ publishedAt: at }).where(inArray(outboxEvent.id, ids));
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.txm.db
      .update(outboxEvent)
      .set({ attempts: sql`${outboxEvent.attempts} + 1`, lastError: error.slice(0, 500) })
      .where(and(eq(outboxEvent.id, id), isNull(outboxEvent.publishedAt)));
  }

  async findById(id: string): Promise<OutboxEventRow | null> {
    const rows = await this.txm.db.select().from(outboxEvent).where(eq(outboxEvent.id, id)).limit(1);
    return rows[0] ?? null;
  }
}
