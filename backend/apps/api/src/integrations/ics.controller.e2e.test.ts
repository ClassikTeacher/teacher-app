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
import { MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import { AuthTokenService } from '@modules/access/http/auth-token.service.js';
import { IdentityModule } from '@modules/identity/identity.module.js';
import { IntegrationsModule } from '@modules/integrations/integrations.module.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { IcsController } from './ics.controller.js';

describe('ICS REST (5.14.2): POST /ics/rotate and the public GET /ics/{token}.ics', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let teacherToken: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.withEnv(testEnv({ DATABASE_URL: tdb.url })),
        DbModule,
        RedisModule,
        S3Module,
        IdentityModule,
        AccessModule,
        PeopleModule,
        ScheduleModule,
        IntegrationsModule,
      ],
      controllers: [IcsController],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api/v1');
    app.useGlobalInterceptors(new EnvelopeInterceptor());
    app.useGlobalFilters(new AppErrorFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const teacher = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    await app
      .get(TeacherProfileRepository)
      .upsert(teacher.id, { subjectIds: [MATH_ID], onboardedAt: new Date() });
    teacherToken = await app.get(AuthTokenService).issue(teacher.id);
  });
  afterAll(async () => {
    await app.close();
    await tdb.drop();
  });

  it('rotates the link for the caller and serves text/calendar for the token, 404 otherwise', async () => {
    const rotated = await app.inject({
      method: 'POST',
      url: '/api/v1/ics/rotate',
      headers: { authorization: `Bearer ${teacherToken}` },
    });
    expect(rotated.statusCode).toBe(201);
    const url = rotated.json<{ data: { url: string } }>().data.url;
    expect(url).toMatch(/\/api\/v1\/ics\/[A-Za-z0-9_-]{43}\.ics$/);
    const path = url.slice(url.indexOf('/api/v1'));
    const feed = await app.inject({ method: 'GET', url: path });
    expect(feed.statusCode).toBe(200);
    expect(feed.headers['content-type']).toContain('text/calendar');
    expect(feed.body.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(feed.body).not.toContain('"success"');
    expect((await app.inject({ method: 'GET', url: `/api/v1/ics/${'x'.repeat(43)}.ics` })).statusCode).toBe(
      404,
    );
    expect((await app.inject({ method: 'GET', url: '/api/v1/ics/short' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/ics/rotate' })).statusCode).toBe(401);
    // the old link stops working after a second rotation
    await app.inject({
      method: 'POST',
      url: '/api/v1/ics/rotate',
      headers: { authorization: `Bearer ${teacherToken}` },
    });
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
  });
});
