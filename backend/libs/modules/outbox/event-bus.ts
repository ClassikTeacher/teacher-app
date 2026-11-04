import { Injectable, Logger } from '@nestjs/common';
import type { DomainEvent } from './domain-event.js';

export interface DeliveredEvent extends DomainEvent {
  id: string;
  createdAt: Date;
  correlationId: string | null;
}

export type EventHandler = (event: DeliveredEvent) => Promise<void>;

/**
 * In-process registry of domain-event handlers (worker side). Handlers must be idempotent:
 * delivery is at-least-once (BullMQ retries) and they key their side effects (e.g. `dedupe_key`).
 */
@Injectable()
export class DomainEventBus {
  private readonly logger = new Logger(DomainEventBus.name);
  private readonly handlers = new Map<string, EventHandler[]>();

  on(type: string, handler: EventHandler): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }

  async dispatch(event: DeliveredEvent): Promise<void> {
    const handlers = this.handlers.get(event.type) ?? [];
    if (handlers.length === 0) {
      this.logger.debug({ type: event.type }, 'no handler for domain event');
      return;
    }
    for (const handler of handlers) await handler(event);
  }

  types(): string[] {
    return [...this.handlers.keys()];
  }
}
