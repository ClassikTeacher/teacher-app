import { Module } from '@nestjs/common';
import { QueueModule } from '@shared/queue/queue.module.js';
import { Clock } from '@shared/time/clock.js';
import { DomainEventBus } from './event-bus.js';
import { OutboxConsumer } from './outbox.consumer.js';
import { OutboxPublisher } from './outbox.publisher.js';
import { OutboxRepository } from './outbox.repository.js';
import { OutboxService } from './outbox.service.js';

const PROVIDERS = [Clock, OutboxService, OutboxRepository, OutboxPublisher, DomainEventBus, OutboxConsumer];

@Module({ imports: [QueueModule], providers: PROVIDERS, exports: PROVIDERS })
export class OutboxModule {}
