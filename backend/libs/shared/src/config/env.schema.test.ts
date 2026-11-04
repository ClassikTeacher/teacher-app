import { describe, expect, it } from 'vitest';
import { botConfigs, parseEnv } from './env.schema.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'a',
  S3_SECRET_KEY: 'b',
  JWT_SECRET: 'x'.repeat(32),
  TELEGRAM_MODE: 'off',
};

const tokens = {
  BOT_AUTH_TOKEN: '1:a',
  BOT_STAFF_TOKEN: '2:b',
  BOT_STUDENT_TOKEN: '3:c',
  BOT_PARENT_TOKEN: '4:d',
};

describe('parseEnv', () => {
  it('applies defaults for optional values', () => {
    const env = parseEnv(base);
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(3000);
    expect(env.PLATFORM_TIMEZONE).toBe('Europe/Minsk');
    expect(env.TRUST_PROXY_HOPS).toBe(0);
    expect(parseEnv({ ...base, ...tokens, TELEGRAM_MODE: undefined }).TELEGRAM_MODE).toBe('polling');
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
  });

  it('fails fast with a readable message when a required value is missing', () => {
    expect(() => parseEnv({ ...base, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  it('treats empty strings as unset', () => {
    expect(parseEnv({ ...base, BOT_STAFF_TOKEN: '' }).BOT_STAFF_TOKEN).toBeUndefined();
    expect(parseEnv({ ...base, API_PORT: '' }).API_PORT).toBe(3000);
  });

  it('requires a webhook secret in webhook mode', () => {
    expect(() => parseEnv({ ...base, ...tokens, TELEGRAM_MODE: 'webhook' })).toThrow(
      /TELEGRAM_WEBHOOK_SECRET/,
    );
    const env = parseEnv({ ...base, ...tokens, TELEGRAM_MODE: 'webhook', TELEGRAM_WEBHOOK_SECRET: 'abc_-1' });
    expect(env.TELEGRAM_MODE).toBe('webhook');
  });

  it('rejects a short JWT secret and a malformed system key hash', () => {
    expect(() => parseEnv({ ...base, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(() => parseEnv({ ...base, SYSTEM_KEY_HASH: 'nothex' })).toThrow(/SYSTEM_KEY_HASH/);
  });

  it('coerces boolean-like strings', () => {
    expect(parseEnv({ ...base, S3_FORCE_PATH_STYLE: 'false' }).S3_FORCE_PATH_STYLE).toBe(false);
    expect(parseEnv({ ...base, S3_FORCE_PATH_STYLE: '1' }).S3_FORCE_PATH_STYLE).toBe(true);
  });

  it('exposes four bot configs keyed by kind', () => {
    const bots = botConfigs(
      parseEnv({ ...base, BOT_STAFF_TOKEN: '1:abc', BOT_STAFF_USERNAME: 'MyStaffBot' }),
    );
    expect(Object.keys(bots)).toEqual(['auth', 'staff', 'student', 'parent']);
    expect(bots.staff).toEqual({ kind: 'staff', token: '1:abc', username: 'MyStaffBot' });
    expect(bots.auth.token).toBeUndefined();
  });
});

describe('parseEnv cross-field rules', () => {
  it('requires all four bot tokens unless TELEGRAM_MODE=off', () => {
    expect(() => parseEnv({ ...base, TELEGRAM_MODE: 'polling' })).toThrow(/BOT_AUTH_TOKEN/);
    expect(parseEnv({ ...base, TELEGRAM_MODE: 'off' }).TELEGRAM_MODE).toBe('off');
    const tokens = {
      BOT_AUTH_TOKEN: '1:a',
      BOT_STAFF_TOKEN: '2:b',
      BOT_STUDENT_TOKEN: '3:c',
      BOT_PARENT_TOKEN: '4:d',
    };
    expect(parseEnv({ ...base, TELEGRAM_MODE: 'polling', ...tokens }).BOT_PARENT_TOKEN).toBe('4:d');
  });

  it('rejects placeholder secrets, http base url and missing system key in production', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      TELEGRAM_MODE: 'off',
      PUBLIC_BASE_URL: 'https://tutor.example',
      SYSTEM_KEY_HASH: 'a'.repeat(64),
    };
    expect(parseEnv(prod).NODE_ENV).toBe('production');
    expect(() => parseEnv({ ...prod, JWT_SECRET: 'change-me-change-me-change-me-change-me' })).toThrow(
      /placeholder/,
    );
    expect(() => parseEnv({ ...prod, S3_SECRET_KEY: 'minioadmin' })).toThrow(/S3_SECRET_KEY/);
    expect(() => parseEnv({ ...prod, SYSTEM_KEY_HASH: undefined })).toThrow(/SYSTEM_KEY_HASH/);
    expect(() => parseEnv({ ...prod, PUBLIC_BASE_URL: 'http://tutor.example' })).toThrow(/https/);
    expect(() => parseEnv({ ...prod, LOG_PRETTY: 'true' })).toThrow(/LOG_PRETTY/);
  });

  it('rejects malformed booleans and unknown timezones', () => {
    expect(() => parseEnv({ ...base, LOG_PRETTY: 'ture' })).toThrow(/LOG_PRETTY/);
    expect(() => parseEnv({ ...base, PLATFORM_TIMEZONE: 'Mars/Olympus' })).toThrow(/IANA/);
  });
});
