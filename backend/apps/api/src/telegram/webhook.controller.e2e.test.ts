import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@shared/config/config.module.js';
import { DbModule } from '@shared/db/db.module.js';
import { AppErrorFilter } from '@shared/http/app-error.filter.js';
import { EnvelopeInterceptor } from '@shared/http/envelope.interceptor.js';
import { RedisModule } from '@shared/redis/redis.module.js';
import { S3Module } from '@shared/s3/s3.module.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { testEnv } from '@test/env.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TelegramModule } from '@telegram/telegram.module.js';
import { WebhookController } from './webhook.controller.js';

describe('Telegram webhook endpoint', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  const secret = 'test-webhook-secret';

  beforeAll(async () => {
    tdb = await createTestDatabase();
    const env = testEnv({ DATABASE_URL: tdb.url, TELEGRAM_MODE: 'off', TELEGRAM_WEBHOOK_SECRET: secret });
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.withEnv(env), DbModule, RedisModule, S3Module, PeopleModule, TelegramModule],
      controllers: [WebhookController],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api/v1');
    app.useGlobalInterceptors(new EnvelopeInterceptor());
    app.useGlobalFilters(new AppErrorFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app.close();
    await tdb.drop();
  });

  const post = (url: string, headers: Record<string, string>, payload: unknown) =>
    app.inject({ method: 'POST', url, headers, payload: payload as Record<string, unknown> });

  it('rejects a missing or wrong secret before looking at the bot name', async () => {
    const noSecret = await post('/api/v1/tg/auth/webhook', {}, { update_id: 1 });
    expect(noSecret.statusCode).toBe(401);
    const wrong = await post(
      '/api/v1/tg/nope/webhook',
      { 'x-telegram-bot-api-secret-token': 'wrong' },
      { update_id: 1 },
    );
    expect(wrong.statusCode).toBe(401);
  });

  it('validates the body and reports unknown bots only to the secret holder', async () => {
    const bad = await post(
      '/api/v1/tg/auth/webhook',
      { 'x-telegram-bot-api-secret-token': secret },
      { nope: true },
    );
    expect(bad.statusCode).toBe(400);
    // bots are not started in TELEGRAM_MODE=off, so a valid secret yields 404 for every bot name
    const unknown = await post(
      '/api/v1/tg/auth/webhook',
      { 'x-telegram-bot-api-secret-token': secret },
      { update_id: 1 },
    );
    expect(unknown.statusCode).toBe(404);
  });
});
