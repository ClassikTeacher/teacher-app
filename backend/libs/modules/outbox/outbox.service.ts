import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import { currentCorrelation } from '@shared/logging/correlation.js';
import type { DomainEvent } from './domain-event.js';
import { outboxEvent } from './schema.js';

/** Appends domain events to the outbox inside the current transaction. Publishing lives in the worker. */
@Injectable()
export class OutboxService {
  constructor(private readonly txm: TransactionManager) {}

  async publish(event: DomainEvent): Promise<string> {
    const id = newId();
    await this.txm.db.insert(outboxEvent).values({
      id,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.type,
      payload: event.payload,
      correlationId: currentCorrelation()?.correlationId ?? null,
    });
    return id;
  }
}
