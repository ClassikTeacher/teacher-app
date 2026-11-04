import { inject } from 'vitest';
import { type Env, parseEnv } from '../libs/shared/src/config/env.schema.js';

/** A validated Env pointing at the Testcontainers services; override per test as needed. */
export function testEnv(overrides: Partial<Record<keyof Env, string>> & { DATABASE_URL: string }): Env {
  return parseEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    TELEGRAM_MODE: 'off',
    REDIS_URL: inject('TEST_REDIS_URL'),
    S3_ENDPOINT: inject('TEST_S3_ENDPOINT'),
    S3_ACCESS_KEY: inject('TEST_S3_ACCESS_KEY'),
    S3_SECRET_KEY: inject('TEST_S3_SECRET_KEY'),
    S3_BUCKET_FILES: 'tutor-test',
    JWT_SECRET: 'test-secret-test-secret-test-secret-test',
    BOT_AUTH_USERNAME: 'TestAuthBot',
    BOT_STAFF_USERNAME: 'TestStaffBot',
    BOT_STUDENT_USERNAME: 'TestStudentBot',
    BOT_PARENT_USERNAME: 'TestParentBot',
    ...overrides,
  });
}
