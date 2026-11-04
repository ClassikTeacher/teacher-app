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
import { ContentModule } from '@modules/content/content.module.js';
import { FilesModule } from '@modules/files/files.module.js';
import { HomeworkModule } from '@modules/homework/homework.module.js';
import { SubmitUseCase } from '@modules/homework/submit.use-case.js';
import { IdentityModule } from '@modules/identity/identity.module.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { ContentController } from '../content/content.controller.js';
import { HomeworkController } from './homework.controller.js';

type Json = { data: unknown };

describe('Content and Homework REST (9.2)', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let teacherToken: string;
  let otherToken: string;
  let studentId: string;
  const inject = async (method: 'GET' | 'POST' | 'DELETE', url: string, token: string, payload?: unknown) => {
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as never,
    });
    return {
      status: res.statusCode,
      data: (res.statusCode < 300 && res.body ? res.json<Json>().data : null) as never,
    };
  };

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
        FilesModule,
        ContentModule,
        HomeworkModule,
      ],
      controllers: [ContentController, HomeworkController],
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
    for (const t of [teacher, other])
      await app
        .get(TeacherProfileRepository)
        .upsert(t.id, { subjectIds: [MATH_ID], onboardedAt: new Date() });
    const student = await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Петя', lastName: '' });
    studentId = student.id;
    const links = app.get(TeacherStudentRepository);
    const link = await links.insertActive({
      teacherId: teacher.id,
      studentId,
      subjectIds: [MATH_ID],
      maxLessonsPerWeek: 2,
      startedAt: new Date(),
    });
    await links.openPeriod(link.id, new Date());
    teacherToken = await tokens.issue(teacher.id);
    otherToken = await tokens.issue(other.id);
  });
  afterAll(async () => {
    await app.close();
    await tdb.drop();
  });

  it('materials, collections and grants: create, grant to the student, read back, foreign ids are 404', async () => {
    const created = await inject('POST', '/materials', teacherToken, {
      kind: 'link',
      title: 'Формулы',
      url: 'https://example.org/f',
    });
    expect(created.status).toBe(201);
    const material = created.data as { id: string };
    const col = await inject('POST', '/collections', teacherToken, {
      title: 'Механика',
      periodFrom: '2026-11-01',
      periodTo: '2026-11-30',
    });
    expect(col.status).toBe(201);
    const colId = (col.data as { id: string }).id;
    expect(
      (await inject('POST', `/collections/${colId}/items`, teacherToken, { materialId: material.id })).status,
    ).toBe(204);
    const grant = await inject('POST', '/grants', teacherToken, {
      subjectType: 'material',
      subjectId: material.id,
      studentId,
    });
    expect(grant.status).toBe(201);
    expect(grant.data).toMatchObject({ granteeType: 'student', studentIds: [studentId] });
    const card = await inject('GET', `/materials/${material.id}`, teacherToken);
    expect(card.data).toMatchObject({ title: 'Формулы', collectionIds: [colId] });
    expect((card.data as { grants: unknown[] }).grants).toHaveLength(1);
    expect((await inject('GET', `/materials/${material.id}`, otherToken)).status).toBe(404);
    const foreign = await inject('POST', '/grants', otherToken, {
      subjectType: 'material',
      subjectId: material.id,
      studentId,
    });
    expect(foreign.status).toBe(404);
    expect(
      (await inject('DELETE', `/grants/${(grant.data as { id: string }).id}`, teacherToken)).status,
    ).toBe(204);
    expect(
      (await inject('POST', '/grants', teacherToken, { subjectType: 'material', subjectId: material.id }))
        .status,
    ).toBe(400);
  });

  it('assignments: create (published), list, the queue after a submission, review, close; validation', async () => {
    const bad = await inject('POST', '/assignments', teacherToken, {
      title: 'x',
      dueMode: 'fixed',
      submissionMode: 'text',
      studentIds: [studentId],
    });
    expect(bad.status).toBe(400); // fixed mode needs dueAt
    const created = await inject('POST', '/assignments', teacherToken, {
      title: 'Квадратные уравнения',
      dueMode: 'fixed',
      dueAt: '2030-01-01T10:00:00Z',
      submissionMode: 'text',
      submissionRules: { acceptLate: false },
      studentIds: [studentId],
    });
    expect(created.status).toBe(201);
    const a = created.data as {
      id: string;
      status: string;
      targets: Array<{ studentId: string; status: string }>;
    };
    expect(a.status).toBe('published');
    expect(a.targets).toEqual([expect.objectContaining({ studentId, status: 'assigned' })]);
    expect((await inject('GET', '/assignments', teacherToken)).data).toHaveLength(1);
    expect((await inject('GET', '/assignments', otherToken)).data).toHaveLength(0);
    expect((await inject('GET', `/assignments/${a.id}`, otherToken)).status).toBe(404);

    const student = {
      accountId: studentId,
      roles: ['STUDENT'] as const,
      status: 'active' as const,
      source: 'api' as const,
    };
    await app.get(SubmitUseCase).execute(student, { assignmentId: a.id, fileIds: [], text: 'x = 2' });
    const queue = await inject('GET', '/submissions?status=submitted', teacherToken);
    expect(queue.data).toEqual([
      expect.objectContaining({ assignmentId: a.id, attemptNo: 1, text: 'x = 2', review: null }),
    ]);
    const submissionId = (queue.data as Array<{ id: string }>)[0]!.id;
    expect(
      (await inject('POST', `/submissions/${submissionId}/review`, otherToken, { decision: 'accepted' }))
        .status,
    ).toBe(404);
    expect(
      (await inject('POST', `/submissions/${submissionId}/review`, teacherToken, { decision: 'returned' }))
        .status,
    ).toBe(400);
    const reviewed = await inject('POST', `/submissions/${submissionId}/review`, teacherToken, {
      decision: 'accepted',
      comment: 'Отлично',
    });
    expect(reviewed.status).toBe(201);
    expect(reviewed.data).toMatchObject({ review: { decision: 'accepted', comment: 'Отлично' } });
    expect((await inject('GET', '/submissions', teacherToken)).data).toHaveLength(0);
    const closed = await inject('POST', `/assignments/${a.id}/close`, teacherToken);
    expect(closed.data).toMatchObject({ status: 'closed' });
  });
});
