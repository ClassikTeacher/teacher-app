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
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { RescheduleRequestUseCase } from '@modules/schedule/reschedule/reschedule-request.use-case.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { RequestsController } from '../requests/requests.controller.js';
import { LessonsController } from './lessons.controller.js';

describe('Lessons REST (UC-14)', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let teacherToken: string;
  let otherToken: string;
  let studentId: string;

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
      controllers: [LessonsController, RequestsController],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api/v1');
    app.useGlobalInterceptors(new EnvelopeInterceptor());
    app.useGlobalFilters(new AppErrorFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const tokens = app.get(AuthTokenService);
    const teacher = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    const other = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    await app
      .get(TeacherProfileRepository)
      .upsert(teacher.id, { subjectIds: [MATH_ID], onboardedAt: new Date() });
    await app
      .get(TeacherProfileRepository)
      .upsert(other.id, { subjectIds: [MATH_ID], onboardedAt: new Date() });
    const student = await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Петя', lastName: '' });
    studentId = student.id;
    await app.get(TeacherStudentRepository).insertActive({
      teacherId: teacher.id,
      studentId,
      subjectIds: [MATH_ID],
      maxLessonsPerWeek: 2,
      startedAt: new Date(),
    });
    teacherToken = await tokens.issue(teacher.id);
    otherToken = await tokens.issue(other.id);
  });
  afterAll(async () => {
    await app.close();
    await tdb.drop();
  });

  const call = (method: 'GET' | 'POST', url: string, token: string, payload?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as never,
    });

  it('creates, lists and reads lessons of the caller; conflicts and foreign access are refused', async () => {
    const startsAt = new Date(Date.now() + 3 * 864e5).toISOString();
    const created = await call('POST', '/lessons', teacherToken, { studentId, startsAt, durationMin: 60 });
    expect(created.statusCode).toBe(201);
    const id = created.json().data.id as string;
    expect(created.json().data).toMatchObject({
      seqNo: 1,
      subject: { name: 'Математика' },
      participants: [{ studentId, displayName: 'Петя' }],
    });
    const again = await call('POST', '/lessons', teacherToken, { studentId, startsAt, durationMin: 30 });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('LESSON_CONFLICT');
    expect((await call('POST', '/lessons', teacherToken, { startsAt, durationMin: 60 })).statusCode).toBe(
      400,
    );
    expect(
      (
        await call('POST', '/lessons', teacherToken, {
          studentId,
          startsAt: '2026-10-21T10:00:00',
          durationMin: 60,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await call('POST', '/lessons', otherToken, { studentId, startsAt, durationMin: 60 })).statusCode,
    ).toBe(409);

    const from = new Date(Date.now()).toISOString();
    const to = new Date(Date.now() + 7 * 864e5).toISOString();
    const list = await call('GET', `/lessons?from=${from}&to=${to}`, teacherToken);
    expect(list.json().data).toEqual([expect.objectContaining({ id })]);
    expect((await call('GET', `/lessons?from=${from}&to=${to}`, otherToken)).json().data).toEqual([]);
    expect((await call('GET', `/lessons/${id}`, otherToken)).statusCode).toBe(404);
    expect((await call('GET', `/lessons/${id}`, teacherToken)).json().data.status).toBe('scheduled');
    const far = new Date(Date.now() + 120 * 864e5).toISOString();
    expect((await call('GET', `/lessons?from=${from}&to=${far}`, teacherToken)).statusCode).toBe(400);
    expect((await call('GET', `/lessons?from=${to}&to=${from}`, teacherToken)).statusCode).toBe(400);
  });

  it('POST /lessons/{id}/cancel (UC-20): a reason is required, foreign lessons are 404, twice is 409', async () => {
    const startsAt = new Date(Date.now() + 5 * 864e5).toISOString();
    const created = await call('POST', '/lessons', teacherToken, { studentId, startsAt, durationMin: 60 });
    const id = created.json().data.id as string;
    expect((await call('POST', `/lessons/${id}/cancel`, teacherToken, { reason: '  ' })).statusCode).toBe(
      400,
    );
    expect((await call('POST', `/lessons/${id}/cancel`, otherToken, { reason: 'x' })).statusCode).toBe(404);
    const done = await call('POST', `/lessons/${id}/cancel`, teacherToken, { reason: 'Заболела' });
    expect(done.statusCode).toBe(201);
    expect(done.json().data).toMatchObject({ id, status: 'cancelled', isLate: false, version: 2 });
    const again = await call('POST', `/lessons/${id}/cancel`, teacherToken, { reason: 'ещё' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('CONFLICT');
  });

  it('POST /lessons/bulk-cancel (UC-22): dryRun previews, then one transaction; the body shape is validated', async () => {
    const day = 10 * 864e5;
    const first = await call('POST', '/lessons', teacherToken, {
      studentId,
      startsAt: new Date(Date.now() + day).toISOString(),
      durationMin: 60,
    });
    const second = await call('POST', '/lessons', teacherToken, {
      studentId,
      startsAt: new Date(Date.now() + day + 36e5).toISOString(),
      durationMin: 60,
    });
    const from = new Date(Date.now() + day - 36e5).toISOString();
    const to = new Date(Date.now() + day + 72e5).toISOString();
    const preview = await call('POST', '/lessons/bulk-cancel', teacherToken, { from, to, dryRun: true });
    expect(preview.statusCode).toBe(201);
    const previewed = (preview.json().data.items as Array<{ lessonId: string }>).map((i) => i.lessonId);
    expect(previewed.sort()).toEqual([first.json().data.id, second.json().data.id].sort());
    expect(preview.json().data.cancellationId).toBeNull();
    expect(
      (await call('POST', '/lessons/bulk-cancel', teacherToken, { from, dryRun: true })).statusCode,
    ).toBe(400);
    expect((await call('POST', '/lessons/bulk-cancel', teacherToken, { from, to })).statusCode).toBe(422); // no reason
    const done = await call('POST', '/lessons/bulk-cancel', teacherToken, { from, to, reason: 'Отпуск' });
    expect(done.statusCode).toBe(201);
    expect(done.json().data.items).toHaveLength(2);
    expect(done.json().data.cancellationId).toEqual(expect.any(String));
    expect((await call('GET', `/lessons/${first.json().data.id}`, teacherToken)).json().data.status).toBe(
      'cancelled',
    );
    const other = await call('POST', '/lessons/bulk-cancel', otherToken, {
      lessonIds: [second.json().data.id],
      reason: 'x',
    });
    expect(other.json().data.items).toEqual([]); // foreign ids are ignored
  });
  it('POST /lessons/{id}/reschedule (UC-18) and /booking-requests (5.7.4): list, accept, decline', async () => {
    const day = 20 * 864e5;
    const created = await call('POST', '/lessons', teacherToken, {
      studentId,
      startsAt: new Date(Date.now() + day).toISOString(),
      durationMin: 60,
    });
    const id = created.json().data.id as string;
    const to = new Date(Date.now() + day + 2 * 36e5).toISOString();
    expect((await call('POST', `/lessons/${id}/reschedule`, otherToken, { startsAt: to })).statusCode).toBe(
      404,
    );
    expect(
      (await call('POST', `/lessons/${id}/reschedule`, teacherToken, { startsAt: 'yesterday' })).statusCode,
    ).toBe(400);
    const moved = await call('POST', `/lessons/${id}/reschedule`, teacherToken, {
      startsAt: to,
      comment: 'Сдвиг',
    });
    expect(moved.statusCode).toBe(201);
    expect(moved.json().data).toMatchObject({ id, startsAt: to, version: 2 });
    // a plea from the student → listed, declined with a message
    const plea = await app
      .get(RescheduleRequestUseCase)
      .ask(
        { accountId: studentId, roles: ['STUDENT'], status: 'active', source: 'api' },
        { lessonId: id, reason: 'Раньше' },
      );
    const list = await call('GET', '/booking-requests', teacherToken);
    expect(list.json().data).toEqual([
      expect.objectContaining({ id: plea.id, kind: 'reschedule_ask', lessonId: id }),
    ]);
    expect((await call('GET', '/booking-requests', otherToken)).json().data).toEqual([]);
    expect((await call('GET', `/booking-requests/${plea.id}`, otherToken)).statusCode).toBe(404);
    expect((await call('POST', `/booking-requests/${plea.id}/decline`, teacherToken, {})).statusCode).toBe(
      400,
    );
    const declined = await call('POST', `/booking-requests/${plea.id}/decline`, teacherToken, {
      message: 'Нет',
    });
    expect(declined.json().data).toMatchObject({ status: 'declined' });
    expect((await call('POST', `/booking-requests/${plea.id}/accept`, teacherToken, {})).statusCode).toBe(
      409,
    );
  });
});
