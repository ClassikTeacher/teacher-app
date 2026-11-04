import { resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { GenericContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';
import { createPool, runMigrations } from '../libs/shared/src/db/index.js';

export const TEMPLATE_DB = 'tutor_template';
export const S3_ACCESS_KEY = 'testadmin';
export const S3_SECRET_KEY = 'testadmin-secret';

/**
 * Starts PostgreSQL, Redis and S3 once per test run, migrates a template database and hands the
 * connection details to test files through `provide` (see test/vitest.d.ts and test/db.ts).
 */
export default async function globalSetup(project: TestProject): Promise<() => Promise<void>> {
  const [pg, redis, s3] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase(TEMPLATE_DB)
      .withUsername('tutor')
      .withPassword('tutor')
      .start(),
    new RedisContainer('redis:7-alpine').start(),
    new GenericContainer('rustfs/rustfs:1.0.3')
      .withEnvironment({ RUSTFS_ACCESS_KEY: S3_ACCESS_KEY, RUSTFS_SECRET_KEY: S3_SECRET_KEY })
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forListeningPorts())
      .start(),
  ]);

  const templateUrl = pg.getConnectionUri();
  const pool = createPool({
    connectionString: templateUrl,
    max: 1,
    applicationName: 'tutor-test-migrate',
    statementTimeoutMs: 10 * 60_000,
  });
  try {
    await runMigrations(pool, resolve(process.cwd(), 'migrations'));
  } finally {
    await pool.end();
  }

  const adminUrl = new URL(templateUrl);
  adminUrl.pathname = '/postgres';
  project.provide('TEST_PG_ADMIN_URL', adminUrl.toString());
  project.provide('TEST_PG_TEMPLATE', TEMPLATE_DB);
  project.provide('TEST_REDIS_URL', redis.getConnectionUrl());
  project.provide('TEST_S3_ENDPOINT', `http://${s3.getHost()}:${s3.getMappedPort(9000)}`);
  project.provide('TEST_S3_ACCESS_KEY', S3_ACCESS_KEY);
  project.provide('TEST_S3_SECRET_KEY', S3_SECRET_KEY);

  return async () => {
    await Promise.all([pg.stop(), redis.stop(), s3.stop()]);
  };
}
