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
import { AuditModule } from '@modules/audit/audit.module.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { AuditController } from './audit.controller.js';

describe('GET /admin/audit', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let adminToken: string;
  let teacherToken: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.withEnv(testEnv({ DATABASE_URL: tdb.url })),
        DbModule,
        RedisModule,
        AccessModule,
        AuditModule,
      ],
      controllers: [AuditController],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api/v1');
    app.useGlobalInterceptors(new EnvelopeInterceptor());
    app.useGlobalFilters(new AppErrorFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const tokens = app.get(AuthTokenService);
    adminToken = await tokens.issue((await createAccount(tdb.txm, { roles: ['ADMIN'] })).id);
    teacherToken = await tokens.issue((await createAccount(tdb.txm, { roles: ['TEACHER'] })).id);
    const audit = app.get(AuditService);
    for (let i = 0; i < 3; i += 1) {
      await audit.record({ actorId: null, action: `test.${i}`, entityType: 'thing', source: 'system' });
    }
  });
  afterAll(async () => {
    await app.close();
    await tdb.drop();
  });

  it('pages the trail for admins and refuses teachers', async () => {
    const page = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit?limit=2&page=1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().meta).toEqual({ page: 1, limit: 2, total: 3 });
    expect(page.json().data).toHaveLength(2);
    expect(page.json().data[0]).toMatchObject({ action: 'test.2', source: 'system' });

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit?action=test.1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(filtered.json().meta.total).toBe(1);

    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit',
      headers: { authorization: `Bearer ${teacherToken}` },
    });
    expect(forbidden.statusCode).toBe(403);
    const bad = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit?limit=500',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(bad.statusCode).toBe(400);
  });
});
