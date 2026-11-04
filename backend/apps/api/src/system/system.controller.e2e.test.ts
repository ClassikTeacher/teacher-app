import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@shared/config/config.module.js';
import { DbModule } from '@shared/db/db.module.js';
import { AppErrorFilter } from '@shared/http/app-error.filter.js';
import { EnvelopeInterceptor } from '@shared/http/envelope.interceptor.js';
import { REDIS, RedisModule } from '@shared/redis/redis.module.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { testEnv } from '@test/env.js';
import { createAccount } from '@test/factories.js';
import type { Redis } from 'ioredis';
import { AccessModule } from '@modules/access/access.module.js';
import { SystemController } from './system.controller.js';

describe('POST /system/super-admin/transfer (X-System-Key)', () => {
  const key = 'super-secret-system-key';
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let adminId: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    const env = testEnv({
      DATABASE_URL: tdb.url,
      SYSTEM_KEY_HASH: createHash('sha256').update(key).digest('hex'),
    });
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.withEnv(env), DbModule, RedisModule, AccessModule],
      controllers: [SystemController],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api/v1');
    app.useGlobalInterceptors(new EnvelopeInterceptor());
    app.useGlobalFilters(new AppErrorFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await app.get<Redis>(REDIS).del('ratelimit:system:127.0.0.1');
    await createAccount(tdb.txm, { roles: ['SUPER_ADMIN'] });
    adminId = (await createAccount(tdb.txm, { roles: ['ADMIN'] })).id;
  });
  afterAll(async () => {
    await app.close();
    await tdb.drop();
  });

  const post = (headers: Record<string, string>, payload: unknown) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/system/super-admin/transfer',
      headers,
      payload: payload as Record<string, unknown>,
    });

  it('rejects a missing or wrong key, accepts the right one, and rate-limits attempts', async () => {
    expect((await post({}, { toAccountId: adminId })).statusCode).toBe(401);
    expect((await post({ 'x-system-key': 'wrong' }, { toAccountId: adminId })).statusCode).toBe(401);
    const ok = await post({ 'x-system-key': key }, { toAccountId: adminId, previousRole: 'ADMIN' });
    expect(ok.statusCode).toBe(202);
    expect(ok.json().data).toMatchObject({ toAccountId: adminId, status: 'pending' });
    expect((await post({ 'x-system-key': key }, { toAccountId: adminId })).statusCode).toBe(409);
    const cancel = await app.inject({
      method: 'DELETE',
      url: `/api/v1/system/super-admin/transfer/${ok.json().data.id}`,
      headers: { 'x-system-key': key },
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().data.status).toBe('cancelled');
    // 6th attempt within the window from the same address
    expect((await post({ 'x-system-key': key }, { toAccountId: adminId })).statusCode).toBe(429);
  });
});
