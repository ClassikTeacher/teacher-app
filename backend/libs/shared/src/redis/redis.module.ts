import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';

export const REDIS = Symbol('REDIS');

/** General-purpose client (sessions, cache, rate limits): commands fail fast when Redis is down. */
export function createRedis(url: string, name = 'tutor-app'): Redis {
  const redis = new Redis(url, {
    connectionName: name,
    maxRetriesPerRequest: 3,
    commandTimeout: 5_000,
    enableReadyCheck: true,
  });
  redis.on('error', (error: Error) => new Logger('Redis').warn({ err: error }, `redis ${name} error`));
  return redis;
}

/** Connection for BullMQ queues/workers, which require `maxRetriesPerRequest: null` (blocking commands). */
export function createQueueRedis(url: string, name = 'tutor-queue'): Redis {
  const redis = new Redis(url, { connectionName: name, maxRetriesPerRequest: null, enableReadyCheck: false });
  redis.on('error', (error: Error) => new Logger('Redis').warn({ err: error }, `redis ${name} error`));
  return redis;
}

@Global()
@Module({
  providers: [{ provide: REDIS, inject: [ENV], useFactory: (env: Env): Redis => createRedis(env.REDIS_URL) }],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
