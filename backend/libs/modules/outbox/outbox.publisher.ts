import { Inject, Injectable, Logger } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { DOMAIN_EVENTS_QUEUE, QUEUES, type QueueRegistry } from '@shared/queue/queue.module.js';
import { Clock } from '@shared/time/clock.js';
import { OutboxRepository } from './outbox.repository.js';

const BATCH = 100;

/**
 * Transactional outbox publisher (7.5): moves events from `outbox_event` to the `domain-events` queue.
 * The job id equals the event id, so a crash between enqueue and `markPublished` cannot create a duplicate job
 * while the previous job still exists in Redis; once completed jobs are pruned a re-publish would run the
 * handlers again, which is why every handler must be idempotent (dedupe keys).
 */
@Injectable()
export class OutboxPublisher {
  private readonly logger = new Logger(OutboxPublisher.name);

  constructor(
    private readonly txm: TransactionManager,
    private readonly repo: OutboxRepository,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    private readonly clock: Clock,
  ) {}

  /** One pass; returns how many events were published. Safe to run concurrently (row locks). */
  async publishPending(): Promise<number> {
    return this.txm.run(async () => {
      const events = await this.repo.lockUnpublished(BATCH);
      if (events.length === 0) return 0;
      const queue = this.queues.get(DOMAIN_EVENTS_QUEUE);
      const published: string[] = [];
      for (const event of events) {
        try {
          await queue.add(
            event.eventType,
            {
              id: event.id,
              type: event.eventType,
              aggregateType: event.aggregateType,
              aggregateId: event.aggregateId,
              payload: event.payload,
              createdAt: event.createdAt.toISOString(),
              correlationId: event.correlationId,
            },
            { jobId: event.id },
          );
          published.push(event.id);
        } catch (error) {
          this.logger.warn({ err: error, event: event.id }, 'enqueue failed; event stays in the outbox');
          await this.repo.markFailed(event.id, error instanceof Error ? error.message : String(error));
          break; // the queue is unavailable: stop this pass, the next tick retries
        }
      }
      await this.repo.markPublished(published, this.clock.now());
      return published.length;
    });
  }
}
