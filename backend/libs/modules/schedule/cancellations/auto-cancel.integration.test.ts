import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount } from '@test/factories.js';
import { drainOutbox } from '@test/outbox.js';
import { linkStudent, MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import type { Actor } from '@modules/access/actor.js';
import { BlockAccountUseCase } from '@modules/identity/block-account.use-case.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { notification } from '@modules/notifications/schema.js';
import { GroupsUseCase } from '@modules/people/groups/groups.use-case.js';
import { EndLinkUseCase } from '@modules/people/links/end-link.use-case.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { BotApiModule } from '@telegram/api/bot-api.module.js';
import { CreateLessonUseCase } from '../lessons/create-lesson.use-case.js';
import { LessonRepository } from '../lessons/lesson.repository.js';
import { BookingRequestRepository } from '../requests/booking-request.repository.js';
import { RescheduleRequestUseCase } from '../reschedule/reschedule-request.use-case.js';
import { ScheduleModule } from '../schedule.module.js';
import { SeriesMaterializer } from '../series/series.materializer.js';
import { SeriesRepository } from '../series/series.repository.js';
import { SeriesUseCase } from '../series/series.use-case.js';
import { CancellationRepository } from './cancellation.repository.js';

const actor = (id: string, role: 'TEACHER' | 'STUDENT' | 'ADMIN'): Actor => ({
  accountId: id,
  roles: [role],
  status: 'active',
  source: 'bot',
});
const utc = (iso: string) => new Date(iso);

describe('5.7.6: automatic cancellations (M4-06)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let lessons: LessonRepository;
  let create: CreateLessonUseCase;
  let annaId: string;
  let olegId: string;
  let petyaId: string;
  let mashaId: string;
  let adminId: string;
  const anna = () => actor(annaId, 'TEACHER');

  const notes = (recipientId: string, type: string) =>
    tdb.db
      .select()
      .from(notification)
      .where(and(eq(notification.recipientId, recipientId), eq(notification.typeCode, type)));
  const lessonAt = (teacherId: string, iso: string, target: { studentId: string } | { groupId: string }) =>
    create.execute(actor(teacherId, 'TEACHER'), { target, startsAt: utc(iso), durationMin: 60 });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [
      PeopleModule,
      AccessModule,
      ScheduleModule,
      BotApiModule,
      NotificationsModule,
    ]);
    lessons = ctx.get(LessonRepository);
    create = ctx.get(CreateLessonUseCase);
    const profiles = ctx.get(TeacherProfileRepository);
    annaId = (
      await createAccount(tdb.txm, {
        roles: ['TEACHER'],
        firstName: 'Анна',
        lastName: 'П',
        timezone: 'Europe/Minsk',
      })
    ).id;
    olegId = (
      await createAccount(tdb.txm, {
        roles: ['TEACHER'],
        firstName: 'Олег',
        lastName: 'Б',
        timezone: 'Europe/Minsk',
      })
    ).id;
    await profiles.upsert(annaId, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now() });
    await profiles.upsert(olegId, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now() });
    petyaId = (
      await createAccount(tdb.txm, {
        roles: ['STUDENT'],
        firstName: 'Петя',
        lastName: 'И',
        timezone: 'Europe/Minsk',
      })
    ).id;
    mashaId = (
      await createAccount(tdb.txm, {
        roles: ['STUDENT'],
        firstName: 'Маша',
        lastName: 'С',
        timezone: 'Europe/Minsk',
      })
    ).id;
    adminId = (await createAccount(tdb.txm, { roles: ['ADMIN'], firstName: 'Админ' })).id;
    for (const t of [annaId, olegId]) {
      await linkStudent(ctx, t, petyaId, { maxLessonsPerWeek: null });
      await linkStudent(ctx, t, mashaId, { maxLessonsPerWeek: null });
    }
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('the teacher ends the link: future individual lessons go with the teacher’s message, group ones only lose the student; pending requests close', async () => {
    ctx.clock.set('2026-10-19T12:00:00Z');
    const groups = ctx.get(GroupsUseCase);
    const groupId = (await groups.create(anna(), { name: '10А', subjectId: MATH_ID })).id;
    await groups.addMember(anna(), groupId, petyaId);
    await groups.addMember(anna(), groupId, mashaId);
    const a = await lessonAt(annaId, '2026-10-22T13:00:00Z', { studentId: petyaId });
    const g = await lessonAt(annaId, '2026-10-23T13:00:00Z', { groupId });
    const other = await lessonAt(olegId, '2026-10-24T13:00:00Z', { studentId: petyaId });
    const plea = await ctx
      .get(RescheduleRequestUseCase)
      .ask(actor(petyaId, 'STUDENT'), { lessonId: a.lesson.id, reason: 'x' });
    const link = (await ctx.get(TeacherStudentRepository).findByPair(annaId, petyaId))!;
    await ctx.get(EndLinkUseCase).execute(anna(), link.id, {
      reason: 'removed_by_teacher',
      message: 'Переезжаю в другой город',
    });
    await drainOutbox(ctx, tdb);
    expect((await lessons.findById(a.lesson.id))!).toMatchObject({ status: 'cancelled' });
    expect((await lessons.findById(g.lesson.id))!.status).toBe('scheduled');
    expect((await lessons.listParticipants(g.lesson.id)).map((p) => p.studentId)).toEqual([mashaId]);
    expect((await lessons.findById(other.lesson.id))!.status).toBe('scheduled'); // another teacher
    const act = (await ctx
      .get(CancellationRepository)
      .findById((await lessons.findById(a.lesson.id))!.cancellationId!))!;
    expect(act).toMatchObject({
      kind: 'system',
      initiatorRole: 'SYSTEM',
      source: 'link.ended',
      reason: 'Переезжаю в другой город',
      initiatorId: annaId,
    });
    expect((await ctx.get(BookingRequestRepository).findById(plea.id))!).toMatchObject({
      status: 'cancelled',
      decisionReason: 'link_ended',
    });
    // one summary to Petya (the teacher caused it); the group removal is its own message
    const summary = await notes(petyaId, 'cancellation.bulk');
    expect(summary).toHaveLength(1);
    expect(summary[0]!.payload).toMatchObject({
      view: 'system-to-student',
      teacher: 'Анна П',
      cancelled: 'чт 22.10 16:00',
      cause: 'Занятия завершены',
      message: 'Переезжаю в другой город',
    });
    expect(await notes(annaId, 'cancellation.bulk')).toHaveLength(0);
    const left = await notes(petyaId, 'group.lessons_left');
    expect(left).toHaveLength(1);
    expect(left[0]!.payload).toMatchObject({ group: '10А', reason: 'link-ended', dates: 'пт 23.10 16:00' });
    // re-delivery of the same event finds nothing to cancel
    const before = (await ctx.get(CancellationRepository).listItems(act.id)).length;
    await drainOutbox(ctx, tdb);
    expect((await ctx.get(CancellationRepository).listItems(act.id)).length).toBe(before);
  });

  it('a series pause cancels its instances as one system batch with one summary per student', async () => {
    ctx.clock.set('2026-10-19T12:00:00Z');
    const series = ctx.get(SeriesUseCase);
    const created = await series.create(anna(), {
      target: { studentId: mashaId },
      weekdays: [2, 4],
      startMin: 16 * 60,
      durationMin: 60,
      startsOn: '2026-10-20',
    });
    await series.pause(anna(), created.series.id, '2026-10-26', '2026-11-01');
    await drainOutbox(ctx, tdb);
    const summaries = (await notes(mashaId, 'cancellation.bulk')).filter(
      (n) => n.payload['cause'] === 'Пауза регулярных занятий',
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.payload).toMatchObject({
      view: 'system-to-student',
      cancelledCount: 2,
      message: 'Регулярные занятия поставлены на паузу',
    });
    expect(String(summaries[0]!.payload['cancelled'])).toContain('вт 27.10 16:00');
    expect(await notes(annaId, 'cancellation.bulk')).toHaveLength(0); // the teacher caused it
  });

  it('blocking a teacher with the «cancel» policy cancels all their future lessons with the admin’s message', async () => {
    ctx.clock.set('2026-10-19T12:00:00Z');
    const x = await lessonAt(olegId, '2026-11-10T13:00:00Z', { studentId: petyaId });
    const y = await lessonAt(olegId, '2026-11-11T13:00:00Z', { studentId: mashaId });
    await ctx.get(BlockAccountUseCase).block(actor(adminId, 'ADMIN'), olegId, {
      reason: 'жалобы',
      lessonsPolicy: 'cancel',
      message: 'Учитель больше не работает на платформе',
    });
    await drainOutbox(ctx, tdb);
    for (const id of [x.lesson.id, y.lesson.id])
      expect((await lessons.findById(id))!.status).toBe('cancelled');
    const act = (await ctx
      .get(CancellationRepository)
      .findById((await lessons.findById(x.lesson.id))!.cancellationId!))!;
    expect(act).toMatchObject({
      source: 'account.blocked',
      reason: 'Учитель больше не работает на платформе',
    });
    const toPetya = (await notes(petyaId, 'cancellation.bulk')).filter(
      (n) => n.payload['cause'] === 'Решение администратора',
    );
    expect(toPetya).toHaveLength(1);
    expect(toPetya[0]!.payload).toMatchObject({ teacher: 'Олег Б' });
    expect(String(toPetya[0]!.payload['cancelled'])).toContain('вт 10.11 16:00'); // Petya's other lesson at Oleg's goes too
    expect((await notes(olegId, 'cancellation.bulk')).length).toBe(0); // blocked accounts get nothing
  });
  it('a stale link.ended after a re-link leaves the new lessons alone; a blocked student loses individual lessons and leaves group ones', async () => {
    ctx.clock.set('2026-10-19T12:00:00Z');
    const links = ctx.get(TeacherStudentRepository);
    const ended = (await links.findByPair(annaId, petyaId))!;
    await links.update(ended.id, { status: 'active', endedAt: null, endReason: null, endMessage: null }); // re-linked
    const fresh = await lessonAt(annaId, '2026-11-20T13:00:00Z', { studentId: petyaId });
    await ctx.get(OutboxService).publish({
      type: 'link.ended',
      aggregateType: 'teacher_student',
      aggregateId: fresh.lesson.id,
      payload: {
        teacherId: annaId,
        studentId: petyaId,
        reason: 'removed_by_teacher',
        byAccountId: annaId,
        message: 'старое событие',
        groupIds: [],
        linkId: ended.id,
        cancelledRequestId: null,
        at: ctx.clock.now().toISOString(),
      },
    });
    await drainOutbox(ctx, tdb);
    expect((await lessons.findById(fresh.lesson.id))!.status).toBe('scheduled');
    const groups = ctx.get(GroupsUseCase);
    const groupId = (await groups.create(anna(), { name: '11Б', subjectId: MATH_ID })).id;
    await groups.addMember(anna(), groupId, petyaId);
    await groups.addMember(anna(), groupId, mashaId);
    const g = await lessonAt(annaId, '2026-11-21T13:00:00Z', { groupId });
    await ctx
      .get(SeriesUseCase)
      .create(anna(), {
        target: { studentId: petyaId },
        weekdays: [1],
        startMin: 10 * 60,
        durationMin: 60,
        startsOn: '2026-11-23',
      });
    await ctx.get(BlockAccountUseCase).block(actor(adminId, 'ADMIN'), petyaId, {
      reason: 'x',
      lessonsPolicy: 'cancel',
      message: 'Доступ закрыт',
    });
    await drainOutbox(ctx, tdb);
    expect((await lessons.findById(fresh.lesson.id))!.status).toBe('cancelled');
    expect((await lessons.findById(g.lesson.id))!.status).toBe('scheduled');
    expect((await lessons.listParticipants(g.lesson.id)).map((p) => p.studentId)).toEqual([mashaId]);
    const toAnna = (await notes(annaId, 'cancellation.bulk')).filter(
      (n) => n.payload['cause'] === 'Решение администратора',
    );
    expect(toAnna).toHaveLength(1);
    expect(toAnna[0]!.payload).toMatchObject({ view: 'system-to-teacher', message: 'Доступ закрыт' });
    expect(
      (await notes(petyaId, 'cancellation.bulk')).some(
        (n) => n.payload['message'] === 'Доступ закрыт', // the blocked person is not messaged
      ),
    ).toBe(false);
    // H-1: Petya's series ended, so the materializer creates nothing new for him
    const series = ctx.get(SeriesUseCase);
    const active = await ctx.get(SeriesRepository).listActiveByStudent(petyaId);
    expect(active).toHaveLength(0);
    await ctx.get(SeriesMaterializer).run();
    const future = await lessons.listByStudent(
      petyaId,
      { start: utc('2026-11-22T00:00:00Z'), end: utc('2027-03-01T00:00:00Z') },
      ['scheduled'],
    );
    expect(future).toHaveLength(0);
    // a blocked teacher: the series ends too and the stored reason is a code, rendered to the student by locale
    const blockedTeacher = (await ctx
      .get(CancellationRepository)
      .findById((await lessons.findById(fresh.lesson.id))!.cancellationId!))!;
    expect(blockedTeacher.reason).toBe('Доступ закрыт');
    expect(series).toBeDefined();
  });
});
