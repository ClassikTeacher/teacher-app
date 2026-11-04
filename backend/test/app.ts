import type { INestApplicationContext, ModuleMetadata, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '../libs/shared/src/config/config.module.js';
import { DbModule } from '../libs/shared/src/db/db.module.js';
import { RedisModule } from '../libs/shared/src/redis/redis.module.js';
import { S3Module } from '../libs/shared/src/s3/s3.module.js';
import { Clock, FixedClock } from '../libs/shared/src/time/clock.js';
import type { TestDatabase } from './db.js';
import { testEnv } from './env.js';

export interface TestContext {
  app: INestApplicationContext;
  clock: FixedClock;
  get<T>(token: Type<T> | symbol | string): T;
  close(): Promise<void>;
}

/**
 * Boots a Nest application context against the per-file test database with a controllable clock.
 * Pass the domain modules under test; shared infrastructure (config, db) is wired automatically.
 */
export async function createTestContext(
  tdb: TestDatabase,
  modules: NonNullable<ModuleMetadata['imports']>,
  options: { now?: string; extraProviders?: ModuleMetadata['providers'] } = {},
): Promise<TestContext> {
  const clock = new FixedClock(options.now ?? '2026-10-19T12:00:00Z');
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.withEnv(testEnv({ DATABASE_URL: tdb.url })),
      DbModule,
      RedisModule,
      S3Module,
      ...modules,
    ],
    providers: options.extraProviders ?? [],
  })
    .overrideProvider(Clock)
    .useValue(clock)
    .compile();
  // No HTTP adapter here (createNestApplication would require @nestjs/platform-express); REST tests build their own.
  const app = await moduleRef.init();
  return {
    app,
    clock,
    get: (token) => app.get(token),
    close: () => app.close(),
  };
}
