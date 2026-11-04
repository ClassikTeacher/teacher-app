import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '@shared/redis/redis.module.js';
import { Clock } from '@shared/time/clock.js';

/** HW-07 💡: a student may upload at most this many files per hour and per day. */
export const UPLOADS_PER_HOUR = 30;
export const UPLOADS_PER_DAY = 100;
const HOUR_S = 60 * 60;
const DAY_S = 24 * HOUR_S;

export interface RateDecision {
  allowed: boolean;
  /** Which window refused: `hour` or `day`. */
  window?: 'hour' | 'day';
}

/**
 * Fixed windows in Redis (`INCR` + `EXPIRE`): cheap and good enough for a protective limit. Counting is atomic
 * and happens before the download, so every attempt (rejected types included) consumes the budget and
 * concurrent uploads cannot all slip under the limit.
 */
@Injectable()
export class UploadRateLimit {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly clock: Clock,
  ) {}

  async acquire(accountId: string): Promise<RateDecision> {
    const [hourKey, dayKey] = this.keys(accountId);
    const results = await this.redis
      .multi()
      .incr(hourKey)
      .expire(hourKey, HOUR_S, 'NX')
      .incr(dayKey)
      .expire(dayKey, DAY_S, 'NX')
      .exec();
    const hour = Number(results?.[0]?.[1] ?? 0);
    const day = Number(results?.[2]?.[1] ?? 0);
    if (hour > UPLOADS_PER_HOUR) return { allowed: false, window: 'hour' };
    if (day > UPLOADS_PER_DAY) return { allowed: false, window: 'day' };
    return { allowed: true };
  }

  /** Tests and admin tooling: how many uploads the windows have seen. */
  async counts(accountId: string): Promise<{ hour: number; day: number }> {
    const [hourKey, dayKey] = this.keys(accountId);
    const [hour, day] = await this.redis.mget(hourKey, dayKey);
    return { hour: Number(hour ?? 0), day: Number(day ?? 0) };
  }

  private keys(accountId: string): [string, string] {
    const now = Math.floor(this.clock.now().getTime() / 1000);
    return [
      `files:rate:${accountId}:h:${Math.floor(now / HOUR_S)}`,
      `files:rate:${accountId}:d:${Math.floor(now / DAY_S)}`,
    ];
  }
}
