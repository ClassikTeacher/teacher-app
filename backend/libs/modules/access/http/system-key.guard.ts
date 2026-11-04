import { createHash, timingSafeEqual } from 'node:crypto';
import { type CanActivate, type ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { ENV, type Env } from '@shared/config/index.js';
import { AppError } from '@shared/errors/app-error.js';
import { REDIS } from '@shared/redis/redis.module.js';

const WINDOW_SECONDS = 60;
const MAX_ATTEMPTS_PER_WINDOW = 5;
const MAX_ATTEMPTS_GLOBAL = 30;

/** IPv6 clients are bucketed by /64 so an attacker cannot rotate addresses inside one allocation. */
export function rateLimitBucket(ip: string): string {
  if (!ip.includes(':')) return ip;
  return ip.split(':').slice(0, 4).join(':') + '::/64';
}

/**
 * `X-System-Key` for `/system/*` (5.3.4): the key is kept as a sha256 hash in the environment, compared in
 * constant time, and attempts are rate-limited per client bucket and globally (fail closed without Redis).
 * Set TRUST_PROXY_HOPS correctly behind a reverse proxy, otherwise every client shares one bucket.
 */
@Injectable()
export class SystemKeyGuard implements CanActivate {
  private readonly logger = new Logger(SystemKeyGuard.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const expected = this.env.SYSTEM_KEY_HASH;
    if (!expected) throw new AppError('FORBIDDEN', 'System API is not configured');
    await this.throttle(request.ip);
    const header = request.headers['x-system-key'];
    const provided = typeof header === 'string' ? createHash('sha256').update(header).digest('hex') : '';
    const a = Buffer.from(provided, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      this.logger.warn({ ip: request.ip, url: request.url }, 'system key rejected');
      throw new AppError('UNAUTHORIZED', 'Bad system key');
    }
    return true;
  }

  private async throttle(ip: string): Promise<void> {
    try {
      const [perClient, global] = await Promise.all([
        this.bump(`ratelimit:system:${rateLimitBucket(ip)}`),
        this.bump('ratelimit:system:*'),
      ]);
      if (perClient > MAX_ATTEMPTS_PER_WINDOW || global > MAX_ATTEMPTS_GLOBAL) {
        this.logger.warn({ ip, perClient, global }, 'system API rate limit hit');
        throw new AppError('RATE_LIMITED', 'Too many attempts');
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('RATE_LIMITED', 'Rate limiter unavailable'); // fail closed for a privileged endpoint
    }
  }

  /** INCR with a TTL that is always present: the key is created with EX and re-expired if the TTL got lost. */
  private async bump(key: string): Promise<number> {
    await this.redis.set(key, '0', 'EX', WINDOW_SECONDS, 'NX');
    const count = await this.redis.incr(key);
    if ((await this.redis.ttl(key)) < 0) await this.redis.expire(key, WINDOW_SECONDS);
    return count;
  }
}
