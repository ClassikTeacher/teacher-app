import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount } from '@test/factories.js';
import { drainOutbox } from '@test/outbox.js';
import { linkStudent, MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import type { Actor } from '@modules/access/actor.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { notification } from '@modules/notifications/schema.js';
import { GroupsUseCase } from '@modules/people/groups/groups.use-case.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { BotApiModule } from '@telegram/api/bot-api.module.js';
import { ScheduleModule } from '../schedule.module.js';
import { CreateLessonUseCase } from './create-lesson.use-case.js';
import { LessonLifecycleJob } from './lesson-lifecycle.job.js';
import { LessonReportUseCase } from './lesson-report.use-case.js';
import { LessonRepository } from './lesson.repository.js';

const asTeacher = (id: string): Actor => ({
  accountId: id,
  roles: ['TEACHER'],
  status: 'active',
  source: 'bot',
});
const utc = (iso: string) => new Date(iso);

describe('UC-38 / UC-24: awaiting_report sweep, report request, completion and not_held', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let report: LessonReportUseCase;
  let teacherId: string;
  let petyaId: string;
  let mashaId: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [
      PeopleModule,
      AccessModule,
      ScheduleModule,
      BotApiModule,
      NotificationsModule,
    ]);
    report = ctx.get(LessonReportUseCase);
    teacherId = (
      await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Анна', timezone: 'Europe/Minsk' })
    ).id;
    await ctx
      .get(TeacherProfileRepository)
      .upsert(teacherId, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now() });
    petyaId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Петя' })).id;
    mashaId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Маша' })).id;
    await linkStudent(ctx, teacherId, petyaId);
    await linkStudent(ctx, teacherId, mashaId);
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('the sweep moves ended lessons to awaiting_report once and asks the teacher with buttons and a 2-hour reminder', async () => {
    const t = asTeacher(teacherId);
    const { lesson } = await ctx.get(CreateLessonUseCase).execute(t, {
      target: { studentId: petyaId },
      startsAt: utc('2026-10-19T13:00:00Z'),
      durationMin: 60,
      plannedTopic: 'Дроби',
    });
    const job = ctx.get(LessonLifecycleJob);
    expect(await job.run()).toBe(0); // 14:00Z has not come yet
    const present = [{ studentId: petyaId, attendance: 'present' as const }];
    await expect(report.complete(t, lesson.id, { topic: true, attendance: present })).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'not_over' },
    });
    ctx.clock.set('2026-10-19T14:00:30Z');
    expect(await job.run()).toBe(1);
    expect(await job.run()).toBe(0);
    const repo = ctx.get(LessonRepository);
    expect((await repo.findById(lesson.id))!.status).toBe('awaiting_report');
    expect((await repo.listEvents(lesson.id)).map((e) => e.type)).toEqual(['created', 'awaiting_report']);
    await drainOutbox(ctx, tdb);
    const asks = await tdb.db
      .select()
      .from(notification)
      .where(eq(notification.typeCode, 'lesson.report_required'));
    expect(asks).toHaveLength(2);
    const now = asks.find((n) => n.dedupeKey === `lesson.report_required:${lesson.id}`)!;
    expect(now.payload).toMatchObject({ who: 'Петя User', when: 'пн 19.10 16:00' });
    expect((now.payload['buttons'] as Array<{ data: string }>).map((b) => b.data)).toEqual([
      `s:today:rep:${lesson.id}:planned`,
      `s:today:rep:${lesson.id}:topic`,
      `s:today:rep:${lesson.id}:noshow`,
      `s:today:rep:${lesson.id}:later`,
    ]);
    const later = asks.find((n) => n.dedupeKey === `lesson.report_reminder:${lesson.id}`)!;
    expect(later.dueAt.toISOString()).toBe('2026-10-19T16:00:30.000Z'); // two hours after the ask (14:00:30Z)
    expect((now.payload['buttons'] as Array<{ data: string }>).some((b) => b.data.endsWith(':noshow'))).toBe(
      true,
    );

    // completing with the planned topic: completed, summary to the student, the reminder dropped
    await expect(report.complete(t, lesson.id, { topic: 'x', attendance: [] })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'attendance_required' },
    });
    const done = await report.complete(t, lesson.id, {
      topic: true,
      attendance: [{ studentId: petyaId, attendance: 'late' }],
      sharedComment: 'Молодец',
    });
    expect(done).toMatchObject({ status: 'completed', topic: 'Дроби', sharedComment: 'Молодец' });
    expect((await repo.listParticipants(lesson.id))[0]!.attendance).toBe('late');
    await drainOutbox(ctx, tdb);
    const summary = await tdb.db
      .select()
      .from(notification)
      .where(eq(notification.typeCode, 'lesson.summary'));
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ recipientId: petyaId, bot: 'student' });
    expect(summary[0]!.payload).toMatchObject({
      topic: 'Дроби',
      comment: 'Молодец',
      attendance: 'late',
      when: 'пн 19.10 16:00',
    });
    const reminder = (await tdb.db.select().from(notification).where(eq(notification.id, later.id)))[0]!;
    expect(reminder.status).toBe('cancelled');
    expect((await tdb.db.select().from(notification).where(eq(notification.id, now.id)))[0]!.status).toBe(
      'cancelled',
    );
    await expect(
      report.complete(t, lesson.id, { topic: 'again', attendance: present }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    ctx.clock.set('2026-10-19T12:00:00Z');
  });

  it('a group lesson needs attendance for everyone; no-show makes it not_held with a reason; strangers get 404', async () => {
    const t = asTeacher(teacherId);
    const groups = ctx.get(GroupsUseCase);
    const group = await groups.create(t, { name: '10А' });
    await groups.addMember(t, group.id, petyaId);
    await groups.addMember(t, group.id, mashaId);
    const create = ctx.get(CreateLessonUseCase);
    const { lesson } = await create.execute(t, {
      target: { groupId: group.id },
      startsAt: utc('2026-10-19T15:00:00Z'),
      durationMin: 60,
    });
    const { lesson: second } = await create.execute(t, {
      target: { studentId: petyaId },
      startsAt: utc('2026-10-19T17:00:00Z'),
      durationMin: 30,
    });
    ctx.clock.set('2026-10-19T18:00:00Z');
    // a lesson over but not yet swept can be reported straight away
    await expect(
      report.complete(t, lesson.id, {
        topic: 'Уравнения',
        attendance: [{ studentId: petyaId, attendance: 'present' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { studentId: mashaId } });
    await expect(report.complete(t, lesson.id, { topic: '', attendance: [] })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'topic_required' },
    });
    const done = await report.complete(t, lesson.id, {
      topic: 'Уравнения',
      attendance: [
        { studentId: petyaId, attendance: 'present' },
        { studentId: mashaId, attendance: 'absent', absenceReason: 'болеет' },
      ],
    });
    expect(done.status).toBe('completed');
    const other = (await createAccount(tdb.txm, { roles: ['TEACHER'] })).id;
    await expect(report.notHeld(asTeacher(other), second.id, 'x')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(report.notHeld(t, second.id, '   ')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const skipped = await report.notHeld(t, second.id, 'Неявка');
    // a cancelled lesson cannot be reported; nothing else is left for the sweep either
    const { lesson: third } = await create.execute(t, {
      target: { studentId: mashaId },
      startsAt: utc('2026-10-19T19:00:00Z'),
      durationMin: 30,
    });
    await ctx
      .get(LessonRepository)
      .update(third.id, { status: 'cancelled', cancelledAt: utc('2026-10-19T18:00:00Z') });
    await expect(report.notHeld(t, third.id, 'x')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await ctx.get(LessonLifecycleJob).run()).toBe(0);
    // «не состоялось» is allowed once the lesson started, `completed` only after it ended (LES-03)
    const { lesson: running } = await create.execute(t, {
      target: { studentId: mashaId },
      startsAt: utc('2026-10-19T17:50:00Z'),
      durationMin: 60,
    });
    await expect(
      report.complete(t, running.id, {
        topic: 'x',
        attendance: [{ studentId: mashaId, attendance: 'present' }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'not_over' } });
    expect((await report.notHeld(t, running.id, 'заболел')).status).toBe('not_held');
    expect(skipped).toMatchObject({ status: 'not_held', notHeldReason: 'Неявка' });
    await drainOutbox(ctx, tdb);
    const summaries = await tdb.db
      .select()
      .from(notification)
      .where(eq(notification.typeCode, 'lesson.summary'));
    expect(summaries.filter((n) => n.payload['topic'] === 'Уравнения')).toHaveLength(2);
    // the absence reason is stored; the no-show lesson lost its reminders (NTF-05)
    const masha = (await ctx.get(LessonRepository).listParticipants(lesson.id)).find(
      (p) => p.studentId === mashaId,
    )!;
    expect(masha.absenceReason).toBe('болеет');
    const live = (await tdb.db.select().from(notification)).filter(
      (n) => n.dedupeKey.includes(second.id) && n.status === 'scheduled',
    );
    expect(live).toHaveLength(0);
    ctx.clock.set('2026-10-19T12:00:00Z');
  });
});
