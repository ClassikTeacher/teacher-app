import { eq, isNull } from 'drizzle-orm';
import type { TestContext } from './app.js';
import type { TestDatabase } from './db.js';
import { DomainEventBus } from '../libs/modules/outbox/event-bus.js';
import { outboxEvent } from '../libs/modules/outbox/schema.js';

/**
 * Delivers every unpublished outbox event of this test database straight to the in-process handlers,
 * bypassing Redis: test files run in parallel and must not consume each other's queue jobs. Events that
 * handlers publish while being delivered are delivered too (bounded, like the worker's periodic pass).
 */
export async function drainOutbox(ctx: TestContext, tdb: TestDatabase, maxPasses = 5): Promise<number> {
  const bus = ctx.get(DomainEventBus);
  let delivered = 0;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const pending = await tdb.db.select().from(outboxEvent).where(isNull(outboxEvent.publishedAt));
    if (pending.length === 0) break;
    for (const row of pending) {
      await bus.dispatch({
        id: row.id,
        type: row.eventType,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        payload: row.payload,
        createdAt: row.createdAt,
        correlationId: row.correlationId,
      });
      await tdb.db.update(outboxEvent).set({ publishedAt: new Date() }).where(eq(outboxEvent.id, row.id));
      delivered += 1;
    }
  }
  return delivered;
}
