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
import { FeatureAdminUseCase } from '@modules/access/features/feature-admin.use-case.js';
import { AuthTokenService } from '@modules/access/http/auth-token.service.js';
import { IdentityModule } from '@modules/identity/identity.module.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { AvailabilityUseCase } from '@modules/schedule/availability/availability.use-case.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { AvailabilityController } from './availability.controller.js';

describe('GET /availability/slots (5.5.4, CAL-08)', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let teacherId: string;
  let teacherToken: string;
  let studentToken: string;

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
      controllers: [AvailabilityController],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api/v1');
    app.useGlobalInterceptors(new EnvelopeInterceptor());
    app.useGlobalFilters(new AppErrorFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const tokens = app.get(AuthTokenService);
    const teacher = await createAccount(tdb.txm, { roles: ['TEACHER'], timezone: 'Europe/Minsk' });
    teacherId = teacher.id;
    await app
      .get(TeacherProfileRepository)
      .upsert(teacherId, { subjectIds: [MATH_ID], calendarMode: 'open_all', onboardedAt: new Date() });
    await app
      .get(AvailabilityUseCase)
      .addRule(
        { accountId: teacherId, roles: ['TEACHER'], status: 'active', source: 'api' },
        { weekdays: [1, 2, 3, 4, 5, 6, 7], startMin: 10 * 60, endMin: 12 * 60 },
      );
    const student = await createAccount(tdb.txm, { roles: ['STUDENT'] });
    await app.get(TeacherStudentRepository).insertActive({
      teacherId,
      studentId: student.id,
      subjectIds: [MATH_ID],
      maxLessonsPerWeek: 2,
      startedAt: new Date(),
    });
    const admin = await createAccount(tdb.txm, { roles: ['ADMIN'] });
    await app
      .get(FeatureAdminUseCase)
      .setTeacher(
        { accountId: admin.id, roles: ['ADMIN'], status: 'active', source: 'api' },
        teacherId,
        'calendar.open_booking',
        { enabled: true },
      );
    teacherToken = await tokens.issue(teacherId);
    studentToken = await tokens.issue(student.id);
  });
  afterAll(async () => {
    await app.close();
    await tdb.drop();
  });

  it('returns grid slots inside the windows for the teacher and the student; validates the query', async () => {
    const from = new Date(Date.now() + 2 * 864e5).toISOString();
    const to = new Date(Date.now() + 5 * 864e5).toISOString();
    const call = (token: string, query: string) =>
      app.inject({
        method: 'GET',
        url: `/api/v1/availability/slots?${query}`,
        headers: { authorization: `Bearer ${token}` },
      });
    const own = await call(teacherToken, `teacherId=${teacherId}&from=${from}&to=${to}`);
    expect(own.statusCode).toBe(200);
    expect(own.json().data).toMatchObject({ teacherId, durationMin: 60, gridStepMin: 30 });
    const slots = own.json().data.slots as Array<{ startsAt: string; endsAt: string }>;
    expect(slots.length).toBeGreaterThan(0);
    // 10:00–12:00 Minsk = 07:00–09:00Z: starts 07:00, 07:30, 08:00 per day
    expect(slots.every((s) => ['07:00', '07:30', '08:00'].includes(s.startsAt.slice(11, 16)))).toBe(true);
    const mine = await call(studentToken, `teacherId=${teacherId}&from=${from}&to=${to}`);
    expect(mine.statusCode).toBe(200);
    expect(
      (await call(studentToken, `teacherId=${teacherId}&from=${from}&to=${to}&durationMin=45`)).statusCode,
    ).toBe(400);
    expect((await call(studentToken, `teacherId=${teacherId}&from=${to}&to=${from}`)).statusCode).toBe(400);
    expect((await call(studentToken, `teacherId=${teacherId}&from=${from}`)).statusCode).toBe(400);
  });
});
