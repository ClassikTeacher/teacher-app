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
import { createAccount } from '@test/factories.js';
import { FakeGoogleApi, GOOGLE_TEST_ENV } from '@test/google.js';
import { MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import { FeatureAdminUseCase } from '@modules/access/features/feature-admin.use-case.js';
import { AuthTokenService } from '@modules/access/http/auth-token.service.js';
import { IdentityModule } from '@modules/identity/identity.module.js';
import { GOOGLE_API } from '@modules/integrations/google/google-api.js';
import { IntegrationsModule } from '@modules/integrations/integrations.module.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { GoogleController } from './google.controller.js';

describe('Google Calendar REST (5.14.1): connect, public callback page, settings, disconnect', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let token: string;
  const google = new FakeGoogleApi();
  const auth = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.withEnv(testEnv({ DATABASE_URL: tdb.url, ...GOOGLE_TEST_ENV })),
        DbModule,
        RedisModule,
        S3Module,
        IdentityModule,
        AccessModule,
        PeopleModule,
        ScheduleModule,
        IntegrationsModule,
      ],
      controllers: [GoogleController],
    })
      .overrideProvider(GOOGLE_API)
      .useValue(google)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api/v1');
    app.useGlobalInterceptors(new EnvelopeInterceptor());
    app.useGlobalFilters(new AppErrorFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const teacher = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    const admin = await createAccount(tdb.txm, { roles: ['ADMIN'] });
    await app
      .get(TeacherProfileRepository)
      .upsert(teacher.id, { subjectIds: [MATH_ID], onboardedAt: new Date() });
    await app
      .get(FeatureAdminUseCase)
      .setTeacher(
        { accountId: admin.id, roles: ['ADMIN'], status: 'active', source: 'api' },
        teacher.id,
        'calendar.google',
        { enabled: true },
      );
    token = await app.get(AuthTokenService).issue(teacher.id);
  });
  afterAll(async () => {
    await app.close();
    await tdb.drop();
  });

  it('walks the whole flow over HTTP; the callback is a plain HTML page without auth', async () => {
    const status = await app.inject({ method: 'GET', url: '/api/v1/integrations/google', headers: auth() });
    expect(status.statusCode).toBe(200);
    expect(status.json<{ data: unknown }>().data).toEqual({ configured: true, connected: false });

    const connect = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations/google/connect',
      headers: auth(),
    });
    expect(connect.statusCode).toBe(201);
    const url = connect.json<{ data: { url: string } }>().data.url;
    const state = new URL(url).searchParams.get('state')!;
    expect(new URL(url).searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/api/v1/integrations/google/callback',
    );

    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/integrations/google/callback?error=access_denied',
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.headers['content-type']).toContain('text/html');
    expect(denied.body).toContain('Вы не предоставили доступ');

    // Google down in the middle of the callback: an HTML page, the state is spent
    google.codes.set('code-down', { email: 'anna@gmail.com' });
    google.outage = new Error('503');
    const down = await app.inject({
      method: 'GET',
      url: `/api/v1/integrations/google/callback?state=${state}&code=code-down`,
    });
    expect(down.statusCode).toBe(502);
    expect(down.body).toContain('Google временно недоступен');
    google.outage = null;

    const connect2 = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations/google/connect',
      headers: auth(),
    });
    const state2 = new URL(connect2.json<{ data: { url: string } }>().data.url).searchParams.get('state')!;
    google.codes.set('code-x', { email: 'anna@gmail.com' });
    // two browsers hit the callback with the same link at once: exactly one wins
    const callback = () =>
      app.inject({ method: 'GET', url: `/api/v1/integrations/google/callback?state=${state2}&code=code-x` });
    const [r1, r2] = await Promise.all([callback(), callback()]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 404]);
    const ok = r1.statusCode === 200 ? r1 : r2;
    expect(ok.body).toContain('Google Calendar подключён');
    expect(ok.body).toContain('https://t.me/TestStaffBot');
    const replay = await callback();
    expect(replay.statusCode).toBe(404);
    expect(replay.body).toContain('Ссылка устарела');

    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/v1/integrations/google',
      headers: auth(),
      payload: { exportEnabled: false, busyCalendarIds: ['primary', 'work@group.calendar.google.com'] },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<{ data: Record<string, unknown> }>().data).toMatchObject({
      connected: true,
      status: 'active',
      email: 'anna@gmail.com',
      exportEnabled: false,
      busyCalendarIds: ['primary', 'work@group.calendar.google.com'],
    });
    const bad = await app.inject({
      method: 'PATCH',
      url: '/api/v1/integrations/google',
      headers: auth(),
      payload: { busyCalendarIds: [] },
    });
    expect(bad.statusCode).toBe(400);

    const sync = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations/google/sync',
      headers: auth(),
    });
    expect(sync.statusCode).toBe(201);
    const gone = await app.inject({ method: 'DELETE', url: '/api/v1/integrations/google', headers: auth() });
    expect(gone.statusCode).toBe(200);
    expect(gone.json<{ data: unknown }>().data).toEqual({ disconnected: true });
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/integrations/google' });
    expect(anonymous.statusCode).toBe(401);
  });
});
