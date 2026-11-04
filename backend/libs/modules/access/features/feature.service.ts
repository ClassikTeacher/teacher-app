import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppError } from '@shared/errors/app-error.js';
import { REDIS } from '@shared/redis/redis.module.js';
import { SYSTEM_ACTOR_ID } from '../actor.js';
import { type FeatureKey, type FeatureLimits } from './catalog.js';
import { FeatureRepository } from './feature.repository.js';
import {
  type GlobalFeatureState,
  type PersonalFeatureState,
  type ResolvedFeature,
  type ResolvedFeatures,
  resolveFeatures,
} from './rules.js';

const CACHE_TTL_SECONDS = 60;
const GLOBAL_VERSION_KEY = 'features:ver';
const teacherVersionKey = (teacherId: string): string => `features:ver:${teacherId}`;

type CachedFeature = Omit<ResolvedFeature, 'key'>;

/**
 * Effective feature flags and limits of a teacher (5.3.1), cached in Redis (5.3.3).
 * Cache keys embed a global and a per-teacher version read *before* the database is consulted, so a reader
 * that computed from pre-commit data writes under a version nobody reads any more once the writer bumped it.
 */
@Injectable()
export class FeatureService implements OnModuleInit {
  private readonly logger = new Logger(FeatureService.name);

  constructor(
    private readonly repo: FeatureRepository,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    const added = await this.repo.seedCatalog();
    if (added > 0) this.logger.log(`feature catalogue: ${added} new entries seeded`);
  }

  async resolve(teacherId: string): Promise<ResolvedFeatures> {
    const cacheKey = await this.cacheKey(teacherId);
    const cached = cacheKey ? await this.readCache(cacheKey) : null;
    if (cached) return cached;
    const resolved = await this.compute(teacherId);
    if (cacheKey) await this.writeCache(cacheKey, resolved);
    return resolved;
  }

  async isEnabled(teacherId: string, key: FeatureKey): Promise<boolean> {
    return (await this.resolve(teacherId)).get(key)?.enabled ?? false;
  }

  /** Use-case guard (5.3.3): throws FEATURE_DISABLED. */
  async assertEnabled(teacherId: string, key: FeatureKey): Promise<void> {
    if (!(await this.isEnabled(teacherId, key))) {
      throw new AppError('FEATURE_DISABLED', `Feature ${key} is disabled`, { feature: key });
    }
  }

  async limits(teacherId: string, key: FeatureKey): Promise<FeatureLimits> {
    return (await this.resolve(teacherId)).get(key)?.limits ?? {};
  }

  /** Numeric limit or null when unlimited. */
  async limit(teacherId: string, key: FeatureKey, name: string): Promise<number | null> {
    const value = (await this.limits(teacherId, key))[name];
    return typeof value === 'number' ? value : null;
  }

  /** Bumps the teacher's version (after a personal change committed). */
  async invalidate(teacherId: string): Promise<void> {
    await this.redis
      .incr(teacherVersionKey(teacherId))
      .catch((error: unknown) =>
        this.logger.error({ err: error, teacherId }, 'feature cache invalidation failed'),
      );
  }

  /** Bumps the global version (after a platform-wide change committed). */
  async invalidateAll(): Promise<void> {
    await this.redis
      .incr(GLOBAL_VERSION_KEY)
      .catch((error: unknown) =>
        this.logger.error({ err: error }, 'global feature cache invalidation failed'),
      );
  }

  /** Uncached read for admin screens (always fresh). */
  async compute(teacherId: string): Promise<ResolvedFeatures> {
    const [globals, personal] = await Promise.all([
      this.repo.listGlobal(),
      this.repo.listPersonal(teacherId),
    ]);
    const globalMap = new Map<FeatureKey, GlobalFeatureState>(
      globals.map((g) => [
        g.key as FeatureKey,
        { globalEnabled: g.globalEnabled, defaultEnabled: g.defaultEnabled, defaultLimits: g.defaultLimits },
      ]),
    );
    const personalMap = new Map<FeatureKey, PersonalFeatureState>(
      personal.map((p) => [p.featureKey as FeatureKey, { enabled: p.enabled, limits: p.limits }]),
    );
    return resolveFeatures(globalMap, personalMap);
  }

  /** Platform defaults (what a teacher without overrides gets). */
  async computeGlobal(): Promise<ResolvedFeatures> {
    return this.compute(SYSTEM_ACTOR_ID);
  }

  /** Null when Redis is unavailable: the caller skips the cache instead of serving stale data. */
  private async cacheKey(teacherId: string): Promise<string | null> {
    try {
      const [global, teacher] = await this.redis.mget(GLOBAL_VERSION_KEY, teacherVersionKey(teacherId));
      return `features:${global ?? '0'}:${teacher ?? '0'}:${teacherId}`;
    } catch (error) {
      this.logger.warn({ err: error }, 'feature cache unavailable');
      return null;
    }
  }

  private async readCache(key: string): Promise<ResolvedFeatures | null> {
    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      const entries = JSON.parse(raw) as Array<[FeatureKey, CachedFeature]>;
      return new Map(entries.map(([k, v]) => [k, { ...v, key: k }]));
    } catch {
      return null;
    }
  }

  private async writeCache(key: string, resolved: ResolvedFeatures): Promise<void> {
    const entries = [...resolved].map(([k, { key: _k, ...rest }]) => [k, rest]);
    await this.redis.set(key, JSON.stringify(entries), 'EX', CACHE_TTL_SECONDS).catch(() => undefined);
  }
}
