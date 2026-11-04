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
import { GradebookModule } from '@modules/gradebook/gradebook.module.js';
import { JournalsUseCase } from '@modules/gradebook/journals.use-case.js';
import { IdentityModule } from '@modules/identity/identity.module.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { GradebookController } from './gradebook.controller.js';
import { ReportsController } from './reports.controller.js';

type Json = { data: unknown; error?: { code: string } | null };

describe('Gradebook REST (9.2 «Gradebook»): journals, entries, stats, custom scale', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let teacherToken: string;
  let otherToken: string;
  let linkId: string;
  const inject = async (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    token: string,
    payload?: unknown,
  ) => {
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as never,
    });
    const body = res.body ? res.json<Json>() : null;
    return { status: res.statusCode, data: body?.data as never, code: body?.error?.code };
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
        GradebookModule,
      ],
      controllers: [GradebookController, ReportsController],
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
    const student = await createAccount(tdb.txm, { roles: ['STUDENT'] });
    for (const t of [teacher, other])
      await app
        .get(TeacherProfileRepository)
        .upsert(t.id, { subjectIds: [MATH_ID], onboardedAt: new Date() });
    const links = app.get(TeacherStudentRepository);
    const link = await links.insertActive({
      teacherId: teacher.id,
      studentId: student.id,
      subjectIds: [MATH_ID],
      maxLessonsPerWeek: null,
      startedAt: new Date(),
    });
    await links.openPeriod(link.id, new Date());
    linkId = link.id;
    await app
      .get(JournalsUseCase)
      .ensureForLink({ linkId, teacherId: teacher.id, studentId: student.id, subjectIds: [MATH_ID] });
    teacherToken = await tokens.issue(teacher.id);
    otherToken = await tokens.issue(other.id);
  });
  afterAll(async () => {
    await app.close();
    await tdb.drop();
  });

  it('lists journals, adds and edits entries, computes stats and hides the card from other teachers', async () => {
    const journals = await inject('GET', `/students/${linkId}/journals`, teacherToken);
    expect(journals.status).toBe(200);
    expect((journals.data as Array<{ type: string }>).map((j) => j.type)).toEqual([
      'school',
      'tests',
      'custom',
    ]);
    expect((await inject('GET', `/students/${linkId}/journals`, otherToken)).status).toBe(404);
    const school = (journals.data as Array<{ id: string; type: string }>).find((j) => j.type === 'school')!;
    const tests = (journals.data as Array<{ id: string; type: string }>).find((j) => j.type === 'tests')!;

    const a = await inject('POST', `/journals/${school.id}/entries`, teacherToken, {
      value: 8,
      date: '2026-10-05',
    });
    expect(a.status).toBe(201);
    expect(a.data).toMatchObject({ value: 8, category: 'current', status: 'confirmed', source: 'teacher' });
    const b = await inject('POST', `/journals/${school.id}/entries`, teacherToken, {
      value: 6,
      category: 'control',
      weight: 2,
      date: '2026-10-20',
    });
    expect(b.status).toBe(201);
    expect((await inject('POST', `/journals/${school.id}/entries`, teacherToken, { value: 11 })).status).toBe(
      400,
    );
    expect(
      (await inject('POST', `/journals/${school.id}/entries`, teacherToken, { value: 5, extra: 1 })).status,
    ).toBe(400);
    expect((await inject('POST', `/journals/${school.id}/entries`, otherToken, { value: 5 })).status).toBe(
      404,
    );

    const edited = await inject('PATCH', `/entries/${(a.data as { id: string }).id}`, teacherToken, {
      value: 9,
    });
    expect(edited.status).toBe(200);
    expect(edited.data).toMatchObject({ value: 9, version: 2 });

    const stats = await inject(
      'GET',
      `/journals/${school.id}/stats?from=2026-10-01&to=2026-10-31`,
      teacherToken,
    );
    expect(stats.status).toBe(200);
    expect(stats.data).toMatchObject({ type: 'school', stats: { count: 2, average: 7 } });
    const card = await inject('GET', `/journals/${school.id}`, teacherToken);
    expect((card.data as { entries: unknown[] }).entries).toHaveLength(2);

    const removed = await inject('DELETE', `/entries/${(b.data as { id: string }).id}`, teacherToken);
    expect(removed.status).toBe(200);
    expect((await inject('GET', `/journals/${school.id}/entries`, teacherToken)).data).toMatchObject({
      pending: [],
    });
    expect(
      ((await inject('GET', `/journals/${school.id}/entries`, teacherToken)).data as { entries: unknown[] })
        .entries,
    ).toHaveLength(1);

    // tests journal: a target and a score with parts
    const settings = await inject('PATCH', `/journals/${tests.id}`, teacherToken, {
      targetPercent: 80,
      visibleToParent: false,
    });
    expect(settings.status).toBe(200);
    expect(settings.data).toMatchObject({ targetPercent: 80, visibleToParent: false });
    const t = await inject('POST', `/journals/${tests.id}/entries`, teacherToken, {
      value: 42,
      max: 60,
      parts: { a: 30, b: 12 },
    });
    expect(t.status).toBe(201);
    expect(t.data).toMatchObject({ value: 42, max: 60, parts: { a: 30, b: 12 } });
    const tstats = await inject('GET', `/journals/${tests.id}/stats`, teacherToken);
    expect(tstats.data).toMatchObject({ type: 'tests', stats: { count: 1, toTarget: -10 } });
  });

  it('POST /reports builds a snapshot, POST /reports/{id}/send sends it once, GET lists and reads it', async () => {
    const draft = await inject('POST', '/reports', teacherToken, {
      linkId,
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(draft.status).toBe(201);
    expect(draft.data).toMatchObject({ status: 'draft', periodFrom: '2026-10-01', snapshot: { version: 1 } });
    const id = (draft.data as { id: string }).id;
    expect((await inject('GET', `/reports?linkId=${linkId}`, teacherToken)).data).toHaveLength(1);
    expect((await inject('GET', `/reports/${id}`, otherToken)).status).toBe(404);
    const sent = await inject('POST', `/reports/${id}/send`, teacherToken, { comment: 'Молодец' });
    expect(sent.status).toBe(201);
    expect(sent.data).toMatchObject({ status: 'sent', comment: 'Молодец' });
    expect((await inject('POST', `/reports/${id}/send`, teacherToken, {})).status).toBe(409);
    const atOnce = await inject('POST', '/reports', teacherToken, {
      linkId,
      from: '2026-11-01',
      to: '2026-11-30',
      send: true,
    });
    expect(atOnce.data).toMatchObject({ status: 'sent' });
    expect(
      (await inject('POST', '/reports', teacherToken, { linkId, from: '2026-11-30', to: '2026-11-01' }))
        .status,
    ).toBe(400);
  });

  it('GET|PUT /grade-scales/custom replaces the scale and refuses bad shapes', async () => {
    expect((await inject('GET', '/grade-scales/custom', teacherToken)).data).toBeNull();
    const put = await inject('PUT', '/grade-scales/custom', teacherToken, {
      title: 'Звёзды',
      values: [{ label: 'Отлично', emoji: '⭐', weight: 3 }, { label: 'Хорошо' }],
    });
    expect(put.status).toBe(200);
    expect(put.data).toMatchObject({
      title: 'Звёзды',
      values: [{ label: 'Отлично', emoji: '⭐', weight: 3, archived: false }, { label: 'Хорошо' }],
    });
    expect(
      (await inject('PUT', '/grade-scales/custom', teacherToken, { values: [{ label: 'Одно' }] })).status,
    ).toBe(400);
    expect(
      (
        await inject('PUT', '/grade-scales/custom', teacherToken, {
          values: [{ label: 'A' }, { label: 'a' }],
        })
      ).status,
    ).toBe(400);
  });
});
