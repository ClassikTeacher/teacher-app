import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@shared/config/config.module.js';
import { DbModule } from '@shared/db/db.module.js';
import { AppErrorFilter } from '@shared/http/app-error.filter.js';
import { EnvelopeInterceptor } from '@shared/http/envelope.interceptor.js';
import { RedisModule } from '@shared/redis/redis.module.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { testEnv } from '@test/env.js';
import { createAccount } from '@test/factories.js';
import { AccessModule } from '@modules/access/access.module.js';
import { AuthTokenService } from '@modules/access/http/auth-token.service.js';
import { FeaturesController } from './features.controller.js';

interface FeatureDto {
  key: string;
  enabled: boolean;
  reason: string | null;
  toggleable: boolean;
  personalEnabled: boolean | null;
  limits: Record<string, number | null>;
}

describe('Admin features REST (UC-07)', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let adminToken: string;
  let teacherId: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.withEnv(testEnv({ DATABASE_URL: tdb.url })),
        DbModule,
        RedisModule,
        AccessModule,
      ],
      controllers: [FeaturesController],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api/v1');
    app.useGlobalInterceptors(new EnvelopeInterceptor());
    app.useGlobalFilters(new AppErrorFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    adminToken = await app
      .get(AuthTokenService)
      .issue((await createAccount(tdb.txm, { roles: ['ADMIN'] })).id);
    teacherId = (await createAccount(tdb.txm, { roles: ['TEACHER'] })).id;
  });
  afterAll(async () => {
    await app.close();
    await tdb.drop();
  });

  const call = (method: 'GET' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: payload as Record<string, unknown>,
    });
  const find = (data: FeatureDto[], key: string) => data.find((f) => f.key === key);

  it('lists the catalogue with effective values and applies per-teacher overrides', async () => {
    const list = await call('GET', '/api/v1/admin/features');
    expect(list.statusCode).toBe(200);
    expect(find(list.json().data, 'storage')).toMatchObject({ enabled: true, toggleable: true });

    const put = await call('PUT', `/api/v1/admin/teachers/${teacherId}/features`, {
      features: [{ key: 'storage', enabled: false, limits: { quotaBytes: 1024 } }],
    });
    expect(put.statusCode).toBe(200);
    expect(find(put.json().data, 'storage')).toMatchObject({
      enabled: false,
      reason: 'personal',
      personalEnabled: false,
      limits: { quotaBytes: 1024 },
    });
    expect(find(put.json().data, 'materials')).toMatchObject({ enabled: false, reason: 'dependency' });

    const bad = await call('PUT', `/api/v1/admin/teachers/${teacherId}/features`, {
      features: [{ key: 'unknown' }],
    });
    expect(bad.statusCode).toBe(400);
  });
});
