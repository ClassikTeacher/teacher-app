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
import { PeopleModule } from '@modules/people/people.module.js';
import { CatalogController } from './catalog.controller.js';

interface SubjectDto {
  name: string;
}
interface FileTypeDto {
  ext: string;
  isAllowed: boolean;
}

describe('catalog REST (subjects, file types)', () => {
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
        PeopleModule,
      ],
      controllers: [CatalogController],
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
  });
  afterAll(async () => {
    await app.close();
    await tdb.drop();
  });

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, token: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as Record<string, unknown>,
    });

  it('teachers read the active subjects; admins add, rename, deactivate (no duplicates)', async () => {
    const list = await call('GET', '/api/v1/subjects', teacherToken);
    expect(list.statusCode).toBe(200);
    expect(list.json().data.length).toBeGreaterThanOrEqual(13);

    expect((await call('POST', '/api/v1/admin/subjects', teacherToken, { name: 'Х' })).statusCode).toBe(403);
    const added = await call('POST', '/api/v1/admin/subjects', adminToken, { name: '  Астрономия ' });
    expect(added.statusCode).toBe(201);
    expect(added.json().data.name).toBe('Астрономия');
    expect(
      (await call('POST', '/api/v1/admin/subjects', adminToken, { name: 'астрономия' })).statusCode,
    ).toBe(409);

    const id = added.json().data.id;
    const patched = await call('PATCH', `/api/v1/admin/subjects/${id}`, adminToken, {
      name: 'Астрофизика',
      isActive: false,
    });
    expect(patched.json().data).toMatchObject({ name: 'Астрофизика', isActive: false });
    const active = await call('GET', '/api/v1/subjects', teacherToken);
    expect((active.json().data as SubjectDto[]).map((s) => s.name)).not.toContain('Астрофизика');
  });

  it('file types: list and toggle, add a new one with category and mime', async () => {
    const before = await call('GET', '/api/v1/admin/file-types', adminToken);
    expect((before.json().data as FileTypeDto[]).find((t) => t.ext === 'zip')).toMatchObject({
      isAllowed: false,
    });
    const put = await call('PUT', '/api/v1/admin/file-types', adminToken, {
      types: [
        { ext: 'zip', isAllowed: true },
        { ext: 'SVG', category: 'image', mime: 'image/svg+xml', isAllowed: false },
      ],
    });
    expect(put.statusCode).toBe(200);
    const data = put.json().data as FileTypeDto[];
    expect(data.find((t) => t.ext === 'zip')).toMatchObject({ isAllowed: true });
    expect(data.find((t) => t.ext === 'svg')).toMatchObject({ isAllowed: false });
    expect(
      (
        await call('PUT', '/api/v1/admin/file-types', adminToken, {
          types: [{ ext: 'nope', isAllowed: true }],
        })
      ).statusCode,
    ).toBe(404);
  });
});
