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
import { GroupsController } from './groups.controller.js';

describe('Groups REST (UC-12)', () => {
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
      ],
      controllers: [GroupsController],
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

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, token: string, payload?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as never,
    });

  it('creates, fills, edits and archives a group; duplicates and foreign access are refused', async () => {
    const created = await call('POST', '/groups', teacherToken, {
      name: '10А физика',
      subjectId: MATH_ID,
      emoji: '🔬',
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().data.id as string;
    expect((await call('POST', '/groups', teacherToken, { name: '10а ФИЗИКА' })).statusCode).toBe(409);
    expect((await call('POST', '/groups', teacherToken, { name: 'x', emoji: 'abc' })).statusCode).toBe(400);

    const added = await call('POST', `/groups/${id}/members`, teacherToken, { studentId });
    expect(added.statusCode).toBe(201);
    expect(added.json().data.members).toHaveLength(1);
    expect(added.json().data.members[0]).toMatchObject({ studentId, displayName: 'Петя' });
    expect((await call('POST', `/groups/${id}/members`, teacherToken, { studentId })).statusCode).toBe(409);
    const stranger = await createAccount(tdb.txm, { roles: ['STUDENT'] });
    const notLinked = await call('POST', `/groups/${id}/members`, teacherToken, { studentId: stranger.id });
    expect(notLinked.statusCode).toBe(409);
    expect(notLinked.json().error.code).toBe('LINK_NOT_ACTIVE');

    expect((await call('GET', `/groups/${id}`, otherToken)).statusCode).toBe(404);
    expect((await call('PATCH', `/groups/${id}`, otherToken, { name: 'hack' })).statusCode).toBe(404);
    const list = await call('GET', '/groups', teacherToken);
    expect(list.json().data).toEqual([expect.objectContaining({ id, memberCount: 1 })]);

    const renamed = await call('PATCH', `/groups/${id}`, teacherToken, {
      name: 'Физика 10',
      defaultDurationMin: 90,
    });
    expect(renamed.json().data).toMatchObject({ name: 'Физика 10', defaultDurationMin: 90 });
    const removed = await call('DELETE', `/groups/${id}/members/${studentId}`, teacherToken);
    expect(removed.json().data.members).toHaveLength(0);

    await call('POST', `/groups/${id}/members`, teacherToken, { studentId });
    const archived = await call('POST', `/groups/${id}/archive`, teacherToken);
    expect(archived.statusCode).toBe(200);
    expect(archived.json().data.archivedAt).not.toBeNull();
    expect((await call('GET', '/groups', teacherToken)).json().data).toHaveLength(0);
    expect((await call('POST', `/groups/${id}/members`, teacherToken, { studentId })).statusCode).toBe(409);
    expect((await call('GET', `/groups/${id}`, teacherToken)).json().data.members).toHaveLength(0);
  });
});
