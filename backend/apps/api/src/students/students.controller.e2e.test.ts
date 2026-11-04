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
import { MATH_ID, PHYSICS_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import { AuthTokenService } from '@modules/access/http/auth-token.service.js';
import { IdentityModule } from '@modules/identity/identity.module.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { MeController } from '../me/me.controller.js';
import { StudentsController } from './students.controller.js';

describe('Students and Me REST (M2-04 acceptance: PATCH /students/{id}, PATCH /me)', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let teacherToken: string;
  let teacherId: string;
  let otherToken: string;
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
      ],
      controllers: [StudentsController, MeController],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api/v1');
    app.useGlobalInterceptors(new EnvelopeInterceptor());
    app.useGlobalFilters(new AppErrorFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const tokens = app.get(AuthTokenService);
    const teacher = await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Анна' });
    teacherId = teacher.id;
    await app
      .get(TeacherProfileRepository)
      .upsert(teacher.id, { subjectIds: [MATH_ID], onboardedAt: new Date() });
    const other = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    await app
      .get(TeacherProfileRepository)
      .upsert(other.id, { subjectIds: [MATH_ID], onboardedAt: new Date() });
    const student = await createAccount(tdb.txm, { roles: ['STUDENT'] });
    teacherToken = await tokens.issue(teacher.id);
    otherToken = await tokens.issue(other.id);
    studentToken = await tokens.issue(student.id);
  });
  afterAll(async () => {
    await app.close();
    await tdb.drop();
  });

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, token: string, payload?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as never,
    });

  it('issues a student card, patches it, lists it and hides it from other teachers', async () => {
    const created = await call('POST', '/students/invitations', teacherToken, {
      subjectIds: [MATH_ID],
      displayName: 'Петя',
    });
    expect(created.statusCode).toBe(201);
    const { data } = created.json();
    expect(data).toMatchObject({ status: 'pending', maxLessonsPerWeek: 2 });
    expect(data.link).toMatch(/t\.me\/TestStudentBot\?start=/);

    const pending = await call('GET', '/students?status=pending', teacherToken);
    expect(pending.json().data).toHaveLength(1);
    expect(pending.json().data[0]).toMatchObject({ id: data.id, displayName: 'Петя' });

    // a pending card is not editable (link must be active)
    const notActive = await call('PATCH', `/students/${data.id}`, teacherToken, { alias: 'Петруша' });
    expect(notActive.statusCode).toBe(409);
    expect(notActive.json().error.code).toBe('LINK_NOT_ACTIVE');

    const foreign = await call('GET', `/students/${data.id}`, otherToken);
    expect(foreign.statusCode).toBe(404);
    const asStudent = await call('GET', '/students', studentToken);
    expect(asStudent.statusCode).toBe(403);
    const bad = await call('PATCH', `/students/${data.id}`, teacherToken, { maxLessonsPerWeek: 0 });
    expect(bad.statusCode).toBe(400);
  });

  it('PATCH /students/{id} on an active card: values, clearing, subjects, calendar; foreign and bad input refused', async () => {
    const student = await createAccount(tdb.txm, {
      roles: ['STUDENT'],
      firstName: 'Петя',
      lastName: 'Иванов',
    });
    const link = await app.get(TeacherStudentRepository).insertActive({
      teacherId,
      studentId: student.id,
      subjectIds: [MATH_ID],
      maxLessonsPerWeek: 2,
      startedAt: new Date(),
    });
    const patched = await call('PATCH', `/students/${link.id}`, teacherToken, {
      alias: 'Петруша',
      grade: '9',
      school: 'Гимназия 1',
      maxLessonsPerWeek: null,
      calendarOpen: true,
      subjectIds: [MATH_ID, PHYSICS_ID],
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().data).toMatchObject({
      displayName: 'Петруша',
      grade: '9',
      school: 'Гимназия 1',
      maxLessonsPerWeek: null,
      calendarOpen: true,
      subjects: [{ name: 'Математика' }, { name: 'Физика' }],
    });
    const cleared = await call('PATCH', `/students/${link.id}`, teacherToken, { grade: null, alias: '' });
    expect(cleared.json().data).toMatchObject({ grade: null, displayName: 'Петя Иванов' });

    expect((await call('PATCH', `/students/${link.id}`, otherToken, { alias: 'x' })).statusCode).toBe(404);
    expect((await call('PATCH', `/students/${link.id}`, teacherToken, { unknown: 1 })).statusCode).toBe(400);
    const badSubject = await call('PATCH', `/students/${link.id}`, teacherToken, {
      subjectIds: ['00000000-0000-7000-8000-000000000000'],
    });
    expect(badSubject.statusCode).toBe(400);
    expect((await call('GET', `/students/${link.id}`, teacherToken)).json().data).toMatchObject({
      grade: null,
      parents: [],
    });
    expect((await call('GET', '/students', teacherToken)).json().data).toHaveLength(1);
  });

  it('GET /me and PATCH /me update profile and settings with validation', async () => {
    const me = await call('GET', '/me', teacherToken);
    expect(me.statusCode).toBe(200);
    expect(me.json().data).toMatchObject({
      firstName: 'Анна',
      subjectIds: [MATH_ID],
      defaultDurationMin: 60,
    });

    const patched = await call('PATCH', '/me', teacherToken, {
      subjectIds: [MATH_ID, PHYSICS_ID],
      bufferBeforeMin: 10,
      studentCanCancel: false,
      studentCancelCutoffHours: null,
      defaultNoticeText: 'Переносим занятие.',
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().data).toMatchObject({
      subjectIds: [MATH_ID, PHYSICS_ID],
      bufferBeforeMin: 10,
      studentCanCancel: false,
      studentCancelCutoffHours: null,
      defaultNoticeText: 'Переносим занятие.',
    });
    expect((await call('PATCH', '/me', teacherToken, { bufferBeforeMin: 999 })).statusCode).toBe(400);
    expect((await call('PATCH', '/me', teacherToken, { unknown: 1 })).statusCode).toBe(400);
    expect((await call('GET', '/me', studentToken)).statusCode).toBe(403);

    const tpl = await call('POST', '/me/templates', teacherToken, { text: 'Болею' });
    expect(tpl.statusCode).toBe(201);
    expect((await call('GET', '/me/templates', teacherToken)).json().data).toHaveLength(1);
    expect((await call('DELETE', `/me/templates/${tpl.json().data.id}`, otherToken)).statusCode).toBe(404);
    expect((await call('DELETE', `/me/templates/${tpl.json().data.id}`, teacherToken)).statusCode).toBe(200);
    expect((await call('GET', '/me/templates', teacherToken)).json().data).toHaveLength(0);
  });
});
