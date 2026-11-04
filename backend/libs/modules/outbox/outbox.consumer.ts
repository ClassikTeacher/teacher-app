import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { type Job, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { runWithCorrelation } from '@shared/logging/correlation.js';
import { DOMAIN_EVENTS_QUEUE, QUEUE_REDIS } from '@shared/queue/queue.module.js';
import { type DeliveredEvent, DomainEventBus } from './event-bus.js';

interface EventJobData {
  id: string;
  type: string;
  aggregateType: string;
  aggregateId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  correlationId: string | null;
}

/** BullMQ worker over `domain-events`: dispatches each event to the registered handlers (at-least-once). */
@Injectable()
export class OutboxConsumer implements OnModuleDestroy {
  private readonly logger = new Logger(OutboxConsumer.name);
  private worker: Worker<EventJobData> | null = null;

  constructor(
    private readonly bus: DomainEventBus,
    @Inject(QUEUE_REDIS) private readonly redis: Redis,
  ) {}

  start(): void {
    this.worker = new Worker<EventJobData>(DOMAIN_EVENTS_QUEUE, (job) => this.process(job), {
      connection: this.redis,
      concurrency: 8,
    });
    this.worker.on('failed', (job, error) =>
      this.logger.warn({ err: error, job: job?.id }, 'domain event handling failed'),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  /** Exposed for tests. */
  async process(job: Pick<Job<EventJobData>, 'data'>): Promise<void> {
    const event: DeliveredEvent = {
      id: job.data.id,
      type: job.data.type,
      aggregateType: job.data.aggregateType,
      aggregateId: job.data.aggregateId,
      payload: job.data.payload,
      createdAt: new Date(job.data.createdAt),
      correlationId: job.data.correlationId,
    };
    await runWithCorrelation(() => this.bus.dispatch(event), {
      correlationId: event.correlationId ?? undefined,
      context: { event: event.type, event_id: event.id },
    });
  }
}
