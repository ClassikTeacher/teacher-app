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
import { MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import { AuthTokenService } from '@modules/access/http/auth-token.service.js';
import { IdentityModule } from '@modules/identity/identity.module.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { PersonalBlockUseCase } from '@modules/schedule/occupancy/personal-block.use-case.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { CalendarController } from './calendar.controller.js';

describe('GET /calendar/busy (CAL-07)', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let teacherId: string;
  let teacherToken: string;
  let studentToken: string;
  let otherToken: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.withEnv(testEnv({ DATABASE_URL: tdb.url })),
        DbModule,
        RedisModule,
        IdentityModule,
        AccessModule,
        PeopleModule,
        ScheduleModule,
      ],
      controllers: [CalendarController],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api/v1');
    app.useGlobalInterceptors(new EnvelopeInterceptor());
    app.useGlobalFilters(new AppErrorFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const tokens = app.get(AuthTokenService);
    const teacher = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    teacherId = teacher.id;
    const student = await createAccount(tdb.txm, { roles: ['STUDENT'] });
    const other = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    await app.get(TeacherStudentRepository).insertActive({
      teacherId,
      studentId: student.id,
      subjectIds: [MATH_ID],
      maxLessonsPerWeek: 2,
      startedAt: new Date(),
    });
    await app.get(PersonalBlockUseCase).create(
      { accountId: teacherId, roles: ['TEACHER'], status: 'active', source: 'api' },
      {
        during: { start: new Date('2027-10-21T10:00:00Z'), end: new Date('2027-10-21T11:00:00Z') },
        title: 'секрет',
      },
    );
    teacherToken = await tokens.issue(teacherId);
    studentToken = await tokens.issue(student.id);
    otherToken = await tokens.issue(other.id);
  });
  afterAll(async () => {
    await app.close();
    await tdb.drop();
  });

  const busy = (
    token: string,
    accountId: string,
    from = '2027-10-21T00:00:00Z',
    to = '2027-10-22T00:00:00Z',
  ) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/calendar/busy?accountId=${accountId}&from=${from}&to=${to}`,
      headers: { authorization: `Bearer ${token}` },
    });

  it('returns intervals only to entitled callers and never leaks the block title', async () => {
    const own = await busy(teacherToken, teacherId);
    expect(own.statusCode).toBe(200);
    expect(own.json().data).toEqual({
      accountId: teacherId,
      busy: [{ startsAt: '2027-10-21T10:00:00.000Z', endsAt: '2027-10-21T11:00:00.000Z' }],
    });
    expect(own.body).not.toContain('секрет');
    expect((await busy(studentToken, teacherId)).statusCode).toBe(404);
    expect((await busy(otherToken, teacherId)).statusCode).toBe(404);
    expect(
      (await busy(teacherToken, teacherId, '2027-10-22T00:00:00Z', '2027-10-21T00:00:00Z')).statusCode,
    ).toBe(400);
    expect((await busy(teacherToken, 'not-a-uuid')).statusCode).toBe(400);
    expect(
      (await busy(teacherToken, teacherId, '2027-10-21T00:00:00', '2027-10-22T00:00:00')).statusCode,
    ).toBe(400);
    const anonymous = await app.inject({
      method: 'GET',
      url: `/api/v1/calendar/busy?accountId=${teacherId}`,
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
