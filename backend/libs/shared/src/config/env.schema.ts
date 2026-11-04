import { z } from 'zod';

import { isValidTimezone } from '../time/timezone.js';

const booleanFromString = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => (typeof v === 'boolean' ? v : v === 'true' || v === '1'));

const PLACEHOLDER_SECRET = /change-me|minioadmin|rustfsadmin/i;

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Human-readable logs via pino-pretty (dev only; pino-pretty is a devDependency). */
  LOG_PRETTY: booleanFromString.default(false),
  PLATFORM_TIMEZONE: z
    .string()
    .refine(isValidTimezone, 'PLATFORM_TIMEZONE must be an IANA zone')
    .default('Europe/Minsk'),
  PLATFORM_LOCALE: z.enum(['ru']).default('ru'),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  /** Number of trusted reverse-proxy hops in front of the API (0 = do not trust X-Forwarded-*). */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  /** Serve Swagger UI at /api/docs. Defaults to on outside production. */
  SWAGGER_ENABLED: booleanFromString.optional(),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET_FILES: z.string().min(1).default('tutor-files'),
  S3_FORCE_PATH_STYLE: booleanFromString.default(true),
  /** Create the bucket at startup (dev/test). In production the bucket is provisioned with least-privilege keys. */
  S3_AUTO_CREATE_BUCKET: booleanFromString.default(true),
  /** clamd host for HW-05; unset → the antivirus step is skipped (`scan_status = skipped`). */
  CLAMAV_HOST: z.string().min(1).optional(),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),

  TELEGRAM_MODE: z.enum(['polling', 'webhook', 'off']).default('polling'),
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,256}$/, 'webhook secret: 1-256 chars of A-Za-z0-9_-')
    .optional(),
  BOT_AUTH_TOKEN: z.string().optional(),
  BOT_STAFF_TOKEN: z.string().optional(),
  BOT_STUDENT_TOKEN: z.string().optional(),
  BOT_PARENT_TOKEN: z.string().optional(),
  BOT_AUTH_USERNAME: z.string().min(1).default('TutorAuthBot'),
  BOT_STAFF_USERNAME: z.string().min(1).default('TutorStaffBot'),
  BOT_STUDENT_USERNAME: z.string().min(1).default('TutorStudentBot'),
  BOT_PARENT_USERNAME: z.string().min(1).default('TutorParentBot'),

  BOOTSTRAP_SUPERADMIN_TELEGRAM_ID: z.coerce.number().int().positive().optional(),
  SYSTEM_KEY_HASH: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'SYSTEM_KEY_HASH must be a sha256 hex digest')
    .optional(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),

  /** Google Calendar (5.14.1, E2-05): the OAuth client; unset → the integration reports «not configured». */
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  /** 32-byte hex key (`openssl rand -hex 32`) that seals Google tokens at rest (10.1). */
  GOOGLE_TOKEN_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'GOOGLE_TOKEN_KEY must be 64 hex characters (32 bytes)')
    .optional(),
});

export type Env = z.infer<typeof envSchema>;

export type BotKind = 'auth' | 'staff' | 'student' | 'parent';
export const BOT_KINDS: readonly BotKind[] = ['auth', 'staff', 'student', 'parent'] as const;

export interface BotConfig {
  kind: BotKind;
  token: string | undefined;
  username: string;
}

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  // Empty strings in .env files mean "not set".
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const problems = crossFieldProblems(result.data);
  if (problems.length > 0) {
    throw new Error(`Invalid environment configuration: ${problems.join('; ')}`);
  }
  return result.data;
}

function crossFieldProblems(env: Env): string[] {
  const problems: string[] = [];
  if (env.TELEGRAM_MODE === 'webhook' && !env.TELEGRAM_WEBHOOK_SECRET) {
    problems.push('TELEGRAM_WEBHOOK_SECRET is required in webhook mode');
  }
  if (env.TELEGRAM_MODE !== 'off') {
    for (const bot of BOT_KINDS) {
      if (!botConfigs(env)[bot].token)
        problems.push(`BOT_${bot.toUpperCase()}_TOKEN is required when TELEGRAM_MODE=${env.TELEGRAM_MODE}`);
    }
  }
  if (env.NODE_ENV === 'production') {
    if (PLACEHOLDER_SECRET.test(env.JWT_SECRET)) problems.push('JWT_SECRET is a placeholder');
    if (env.TELEGRAM_WEBHOOK_SECRET && PLACEHOLDER_SECRET.test(env.TELEGRAM_WEBHOOK_SECRET)) {
      problems.push('TELEGRAM_WEBHOOK_SECRET is a placeholder');
    }
    if (PLACEHOLDER_SECRET.test(env.S3_SECRET_KEY)) problems.push('S3_SECRET_KEY is a placeholder');
    if (!env.SYSTEM_KEY_HASH) problems.push('SYSTEM_KEY_HASH is required in production');
    if (!env.PUBLIC_BASE_URL.startsWith('https://'))
      problems.push('PUBLIC_BASE_URL must use https in production');
    if (env.LOG_PRETTY) problems.push('LOG_PRETTY is not available in production');
  }
  if ((env.GOOGLE_CLIENT_ID ?? env.GOOGLE_CLIENT_SECRET) && !googleConfig(env)) {
    problems.push('GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_TOKEN_KEY must be set together');
  }
  return problems;
}

export function botConfigs(env: Env): Record<BotKind, BotConfig> {
  return {
    auth: { kind: 'auth', token: env.BOT_AUTH_TOKEN, username: env.BOT_AUTH_USERNAME },
    staff: { kind: 'staff', token: env.BOT_STAFF_TOKEN, username: env.BOT_STAFF_USERNAME },
    student: { kind: 'student', token: env.BOT_STUDENT_TOKEN, username: env.BOT_STUDENT_USERNAME },
    parent: { kind: 'parent', token: env.BOT_PARENT_TOKEN, username: env.BOT_PARENT_USERNAME },
  };
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  tokenKeyHex: string;
}

/** The Google OAuth client, or null when the integration is not configured on this installation. */
export function googleConfig(env: Env): GoogleConfig | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_TOKEN_KEY) return null;
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    tokenKeyHex: env.GOOGLE_TOKEN_KEY,
  };
}
