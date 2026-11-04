import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Queue, type QueueOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { ENV } from '../config/config.module.js';
import type { BotKind, Env } from '../config/env.schema.js';
import { createQueueRedis } from '../redis/redis.module.js';

export const QUEUE_REDIS = Symbol('QUEUE_REDIS');
export const QUEUES = Symbol('QUEUES');

export const DOMAIN_EVENTS_QUEUE = 'domain-events';
// BullMQ forbids ':' in queue names.
export const sendQueueName = (bot: BotKind): `send-${BotKind}` => `send-${bot}`;

export type QueueName = typeof DOMAIN_EVENTS_QUEUE | `send-${BotKind}`;

/** Lazily created BullMQ queues sharing one dedicated Redis connection (T-03). */
export class QueueRegistry {
  private readonly queues = new Map<string, Queue>();

  constructor(private readonly connection: Redis) {}

  get(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      const options: QueueOptions = {
        connection: this.connection,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: 1_000,
          removeOnFail: 5_000,
        },
      };
      queue = new Queue(name, options);
      this.queues.set(name, queue);
    }
    return queue;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
  }
}

@Global()
@Module({
  providers: [
    { provide: QUEUE_REDIS, inject: [ENV], useFactory: (env: Env): Redis => createQueueRedis(env.REDIS_URL) },
    { provide: QUEUES, inject: [QUEUE_REDIS], useFactory: (redis: Redis) => new QueueRegistry(redis) },
  ],
  exports: [QUEUE_REDIS, QUEUES],
})
export class QueueModule implements OnApplicationShutdown {
  constructor(
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    @Inject(QUEUE_REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.queues.closeAll();
    await this.redis.quit().catch(() => undefined);
  }
}
