import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@shared/config/config.module.js';
import { DbModule } from '@shared/db/db.module.js';
import { AppErrorFilter } from '@shared/http/app-error.filter.js';
import { EnvelopeInterceptor } from '@shared/http/envelope.interceptor.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { testEnv } from '@test/env.js';
import { createAccount } from '@test/factories.js';
import { AccessModule } from '@modules/access/access.module.js';
import { AuthTokenService } from '@modules/access/http/auth-token.service.js';
import { IdentityModule } from '@modules/identity/identity.module.js';
import { AdminController } from './admin.controller.js';

describe('Admin REST (bearer auth + envelope)', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let tokens: AuthTokenService;
  let adminToken: string;
  let teacherToken: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.withEnv(testEnv({ DATABASE_URL: tdb.url })),
        DbModule,
        IdentityModule,
        AccessModule,
      ],
      controllers: [AdminController],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api/v1');
    app.useGlobalInterceptors(new EnvelopeInterceptor());
    app.useGlobalFilters(new AppErrorFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    tokens = app.get(AuthTokenService);
    const admin = await createAccount(tdb.txm, { roles: ['ADMIN'] });
    const teacher = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    adminToken = await tokens.issue(admin.id);
    teacherToken = await tokens.issue(teacher.id);
  });

  afterAll(async () => {
    await app.close();
    await tdb.drop();
  });

  const inject = (opts: { method: 'POST' | 'DELETE'; url: string; token?: string; payload?: unknown }) =>
    app.inject({
      method: opts.method,
      url: opts.url,
      headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
      payload: opts.payload as Record<string, unknown> | undefined,
    });

  it('rejects missing, malformed and expired tokens with the error envelope', async () => {
    const none = await inject({
      method: 'POST',
      url: '/api/v1/admin/invitations',
      payload: { role: 'TEACHER' },
    });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toMatchObject({ success: false, data: null, error: { code: 'UNAUTHORIZED' } });

    const expired = await tokens.issue('00000000-0000-7000-8000-000000000001', -10);
    const res = await inject({
      method: 'POST',
      url: '/api/v1/admin/invitations',
      token: expired,
      payload: { role: 'TEACHER' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('forbids teachers and validates the body', async () => {
    const forbidden = await inject({
      method: 'POST',
      url: '/api/v1/admin/invitations',
      token: teacherToken,
      payload: { role: 'TEACHER' },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe('FORBIDDEN');

    const invalid = await inject({
      method: 'POST',
      url: '/api/v1/admin/invitations',
      token: adminToken,
      payload: { role: 'STUDENT' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { issues: [{ path: 'role' }] },
    });
  });

  it('admin creates and revokes a teacher invitation; only the super admin manages admins', async () => {
    const created = await inject({
      method: 'POST',
      url: '/api/v1/admin/invitations',
      token: adminToken,
      payload: { role: 'TEACHER', displayName: 'Анна' },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.success).toBe(true);
    expect(body.data.link).toMatch(/^https:\/\/t\.me\/TestAuthBot\?start=/);

    const revoked = await inject({
      method: 'DELETE',
      url: `/api/v1/admin/invitations/${body.data.id}`,
      token: adminToken,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().data.status).toBe('revoked');

    const grant = await inject({
      method: 'POST',
      url: '/api/v1/admin/admins',
      token: adminToken,
      payload: { accountId: body.data.id },
    });
    expect(grant.statusCode).toBe(403);
  });
});
