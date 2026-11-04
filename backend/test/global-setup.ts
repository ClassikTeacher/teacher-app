import { resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { GenericContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';
import { createPool, runMigrations } from '../libs/shared/src/db/index.js';
import { FakeS3 } from './local-services.js';

export const TEMPLATE_DB = 'tutor_template';
export const S3_ACCESS_KEY = 'testadmin';
export const S3_SECRET_KEY = 'testadmin-secret';

/**
 * Starts PostgreSQL, Redis and S3 once per test run, migrates a template database and hands the
 * connection details to test files through `provide` (see test/vitest.d.ts and test/db.ts).
 */
export default async function globalSetup(project: TestProject): Promise<() => Promise<void>> {
  if (process.env['TEST_SERVICES'] === 'local') return localSetup(project);
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
  await migrateTemplate(templateUrl);

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

/**
 * `TEST_SERVICES=local`: a PostgreSQL 16 (`TEST_PG_URL`, a superuser able to CREATE DATABASE and the
 * `btree_gist` extension) and a Redis (`TEST_REDIS_URL`) already running on this machine, plus an in-process
 * S3 stand-in. The template database is dropped and re-created from the migrations on every run.
 */
async function localSetup(project: TestProject): Promise<() => Promise<void>> {
  const pgUrl = process.env['TEST_PG_URL'] ?? 'postgres://tutor:tutor@127.0.0.1:5432/postgres';
  const redisUrl = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379';
  const admin = new URL(pgUrl);
  admin.pathname = '/postgres';
  const adminPool = createPool({
    connectionString: admin.toString(),
    max: 1,
    applicationName: 'tutor-test-admin',
  });
  try {
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
    await adminPool.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  } finally {
    await adminPool.end();
  }
  const templateUrl = new URL(pgUrl);
  templateUrl.pathname = `/${TEMPLATE_DB}`;
  await migrateTemplate(templateUrl.toString());
  const s3 = new FakeS3();
  const s3Endpoint = await s3.start();

  project.provide('TEST_PG_ADMIN_URL', admin.toString());
  project.provide('TEST_PG_TEMPLATE', TEMPLATE_DB);
  project.provide('TEST_REDIS_URL', redisUrl);
  project.provide('TEST_S3_ENDPOINT', s3Endpoint);
  project.provide('TEST_S3_ACCESS_KEY', S3_ACCESS_KEY);
  project.provide('TEST_S3_SECRET_KEY', S3_SECRET_KEY);
  return () => s3.stop();
}

async function migrateTemplate(templateUrl: string): Promise<void> {
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
}
