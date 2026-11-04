import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount } from '@test/factories.js';
import { linkStudent, MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import type { Actor } from '@modules/access/actor.js';
import { FeatureAdminUseCase } from '@modules/access/features/feature-admin.use-case.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { CreateLessonUseCase } from '@modules/schedule/lessons/create-lesson.use-case.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { IntegrationsModule } from './integrations.module.js';
import { IcsUseCase } from './ics.use-case.js';

describe('M6-04 ICS subscription (5.14.2): secret links per role, re-issue, feature gate', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let ics: IcsUseCase;
  let teacherId: string;
  let petyaId: string;
  let mamaId: string;
  let adminId: string;
  const actor = (id: string, role: Actor['roles'][number]): Actor => ({
    accountId: id,
    roles: [role],
    status: 'active',
    source: 'bot',
  });
  const tokenOf = (url: string): string => /\/ics\/([A-Za-z0-9_-]{43})\.ics$/.exec(url)![1]!;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [AccessModule, PeopleModule, ScheduleModule, IntegrationsModule], {
      now: '2026-11-04T10:00:00Z',
    });
    ics = ctx.get(IcsUseCase);
    teacherId = (await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Анна', lastName: 'Петрова' }))
      .id;
    await ctx
      .get(TeacherProfileRepository)
      .upsert(teacherId, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now() });
    petyaId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Петя', lastName: 'Иванов' }))
      .id;
    mamaId = (await createAccount(tdb.txm, { roles: ['PARENT'], firstName: 'Мама' })).id;
    adminId = (await createAccount(tdb.txm, { roles: ['ADMIN'] })).id;
    await ctx.get(FamilyLinkRepository).insert({
      parentId: mamaId,
      studentId: petyaId,
      invitedBy: teacherId,
      invitationId: null,
      confirmedAt: ctx.clock.now(),
    });
    await linkStudent(ctx, teacherId, petyaId, { maxLessonsPerWeek: null });
    await ctx.get(CreateLessonUseCase).execute(actor(teacherId, 'TEACHER'), {
      target: { studentId: petyaId },
      startsAt: new Date('2026-11-06T10:00:00Z'),
      durationMin: 60,
      format: 'online',
    });
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('issues a link per role; the feed names the other side only; re-issuing kills the old link', async () => {
    const teacherUrl = await ics.rotate(actor(teacherId, 'TEACHER'));
    expect(teacherUrl).toMatch(/^http:\/\/localhost:3000\/api\/v1\/ics\/[A-Za-z0-9_-]{43}\.ics$/);
    const teacherFeed = await ics.feed(tokenOf(teacherUrl));
    expect(teacherFeed).toContain('SUMMARY:Математика — Петя Иванов');
    expect(teacherFeed).toContain('DTSTART:20261106T100000Z');
    expect(teacherFeed).toContain('DESCRIPTION:Онлайн');
    expect(teacherFeed).not.toContain('Анна');

    const studentUrl = await ics.rotate(actor(petyaId, 'STUDENT'));
    expect(await ics.feed(tokenOf(studentUrl))).toContain('SUMMARY:Математика — Анна Петрова');
    const parentUrl = await ics.rotate(actor(mamaId, 'PARENT'));
    expect(await ics.feed(tokenOf(parentUrl))).toContain('SUMMARY:Петя: Математика — Анна Петрова');
    await expect(ics.rotate(actor(adminId, 'ADMIN'))).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(await ics.hasLink(actor(teacherId, 'TEACHER'))).toBe(true);
    const rotated = await ics.rotate(actor(teacherId, 'TEACHER'));
    expect(rotated).not.toBe(teacherUrl);
    await expect(ics.feed(tokenOf(teacherUrl))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await ics.feed(tokenOf(rotated))).toContain('BEGIN:VEVENT');
    await expect(ics.feed('not-a-token')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(ics.feed('A'.repeat(43))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('5.3.3: with calendar.ics off the teacher cannot issue a link and disappears from the student feed', async () => {
    const studentUrl = await ics.rotate(actor(petyaId, 'STUDENT'));
    await ctx
      .get(FeatureAdminUseCase)
      .setTeacher(actor(adminId, 'ADMIN'), teacherId, 'calendar.ics', { enabled: false });
    await expect(ics.rotate(actor(teacherId, 'TEACHER'))).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
    expect(await ics.feed(tokenOf(studentUrl))).not.toContain('BEGIN:VEVENT');
    await ctx
      .get(FeatureAdminUseCase)
      .setTeacher(actor(adminId, 'ADMIN'), teacherId, 'calendar.ics', { enabled: true });
    expect(await ics.feed(tokenOf(studentUrl))).toContain('BEGIN:VEVENT');
  });

  it('review M4: two rotations at once (a double tap) both succeed and exactly one link stays live', async () => {
    const [a, b] = await Promise.all([
      ics.rotate(actor(petyaId, 'STUDENT')),
      ics.rotate(actor(petyaId, 'STUDENT')),
    ]);
    expect(a).not.toBe(b);
    const results = await Promise.allSettled([ics.feed(tokenOf(a)), ics.feed(tokenOf(b))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});
