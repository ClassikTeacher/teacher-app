import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount } from '@test/factories.js';
import { drainOutbox } from '@test/outbox.js';
import { linkStudent, MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import type { Actor } from '@modules/access/actor.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { CancelLessonUseCase } from '@modules/schedule/cancellations/cancel-lesson.use-case.js';
import { CreateLessonUseCase } from '@modules/schedule/lessons/create-lesson.use-case.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { BotApiModule } from '@telegram/api/bot-api.module.js';
import { DailyDigestJob } from './digest.job.js';
import { NotificationSettingsUseCase } from './notification-settings.use-case.js';
import { NotificationService } from './notification.service.js';
import { NotificationsModule } from './notifications.module.js';
import { notification } from './schema.js';

const actor = (id: string, role: 'TEACHER' | 'STUDENT' | 'PARENT'): Actor => ({
  accountId: id,
  roles: [role],
  status: 'active',
  source: 'bot',
});
const utc = (iso: string) => new Date(iso);

describe('M4-05: copies to parents, stand-in parents, quiet hours, personal reminders, digest, unreachable channel', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let notifications: NotificationService;
  let settings: NotificationSettingsUseCase;
  let annaId: string;
  let petyaId: string;
  let mamaId: string;
  let papaId: string;
  const anna = () => actor(annaId, 'TEACHER');

  const rows = (recipientId: string, type: string) =>
    tdb.db
      .select()
      .from(notification)
      .where(and(eq(notification.recipientId, recipientId), eq(notification.typeCode, type)));

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [
      PeopleModule,
      AccessModule,
      ScheduleModule,
      BotApiModule,
      NotificationsModule,
    ]);
    notifications = ctx.get(NotificationService);
    settings = ctx.get(NotificationSettingsUseCase);
    annaId = (
      await createAccount(tdb.txm, {
        roles: ['TEACHER'],
        firstName: 'Анна',
        lastName: 'П',
        timezone: 'Europe/Minsk',
      })
    ).id;
    await ctx
      .get(TeacherProfileRepository)
      .upsert(annaId, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now() });
    petyaId = (
      await createAccount(tdb.txm, {
        roles: ['STUDENT'],
        firstName: 'Петя',
        lastName: 'Иванов',
        timezone: 'Europe/Minsk',
      })
    ).id;
    mamaId = (
      await createAccount(tdb.txm, {
        roles: ['PARENT'],
        firstName: 'Мария',
        lastName: 'И',
        timezone: 'Europe/Minsk',
      })
    ).id;
    papaId = (
      await createAccount(tdb.txm, {
        roles: ['PARENT'],
        firstName: 'Иван',
        lastName: 'И',
        timezone: 'Asia/Yekaterinburg',
      })
    ).id;
    const family = ctx.get(FamilyLinkRepository);
    for (const parentId of [mamaId, papaId])
      await family.insert({
        parentId,
        studentId: petyaId,
        invitedBy: annaId,
        invitationId: null,
        confirmedAt: ctx.clock.now(),
      });
    await linkStudent(ctx, annaId, petyaId, { maxLessonsPerWeek: null });
    const accounts = ctx.get(AccountRepository);
    for (const [id, bot] of [
      [annaId, 'staff'],
      [petyaId, 'student'],
      [mamaId, 'parent'],
      [papaId, 'parent'],
    ] as const)
      await accounts.upsertBotChat(id, bot, 1000 + Math.floor(Math.random() * 1e6));
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('NTF-01…03: copies by type default, the teacher default, the per-student override; a parent mutes non-critical copies only', async () => {
    ctx.clock.set('2026-10-19T12:00:00Z');
    // lesson.summary is copied by default → both parents, signed for Petya, in the parents' zones
    await notifications.schedule({
      type: 'lesson.summary',
      recipientId: petyaId,
      payload: { when: 'x' },
      dedupeKey: 'sum:1',
      teacherId: annaId,
    });
    expect(await rows(petyaId, 'lesson.summary')).toHaveLength(1);
    const mama = await rows(mamaId, 'lesson.summary');
    expect(mama).toHaveLength(1);
    expect(mama[0]).toMatchObject({ route: 'cc', forAccountId: petyaId, bot: 'parent' });
    expect(mama[0]!.payload).toMatchObject({ forName: 'Петя Иванов' });
    expect(mama[0]!.ccOfId).not.toBeNull();
    expect(await rows(papaId, 'lesson.summary')).toHaveLength(1);
    // the teacher switches the default off → no copy; a per-student override switches it back on for Petya
    await settings.toggleCcDefault(anna(), 'lesson.summary');
    await notifications.schedule({
      type: 'lesson.summary',
      recipientId: petyaId,
      payload: {},
      dedupeKey: 'sum:2',
      teacherId: annaId,
    });
    expect(await rows(mamaId, 'lesson.summary')).toHaveLength(1);
    await settings.toggleStudentCc(anna(), petyaId, 'lesson.summary');
    expect(
      (await settings.studentCc(anna(), petyaId)).items.find((i) => i.type === 'lesson.summary'),
    ).toMatchObject({ enabled: true, overridden: true });
    await notifications.schedule({
      type: 'lesson.summary',
      recipientId: petyaId,
      payload: {},
      dedupeKey: 'sum:3',
      teacherId: annaId,
    });
    expect(await rows(mamaId, 'lesson.summary')).toHaveLength(2);
    await settings.resetStudentCc(anna(), petyaId);
    await settings.toggleCcDefault(anna(), 'lesson.summary'); // back to on
    // NTF-02: mama mutes lesson.summary copies — Petya still gets it, papa still gets the copy
    await settings.toggleMute(actor(mamaId, 'PARENT'), 'lesson.summary');
    await notifications.schedule({
      type: 'lesson.summary',
      recipientId: petyaId,
      payload: {},
      dedupeKey: 'sum:4',
      teacherId: annaId,
    });
    expect(await rows(mamaId, 'lesson.summary')).toHaveLength(2);
    expect(await rows(papaId, 'lesson.summary')).toHaveLength(3); // sum:1, sum:3, sum:4
    // a cancellation of a lesson tomorrow is critical: a mute does not stop the copy; next month it does
    await settings.toggleMute(actor(mamaId, 'PARENT'), 'lesson.cancelled');
    await notifications.schedule({
      type: 'lesson.cancelled',
      recipientId: petyaId,
      payload: {},
      dedupeKey: 'cnl:1',
      teacherId: annaId,
      lessonStartsAt: utc('2026-10-20T10:00:00Z'),
    });
    await notifications.schedule({
      type: 'lesson.cancelled',
      recipientId: petyaId,
      payload: {},
      dedupeKey: 'cnl:2',
      teacherId: annaId,
      lessonStartsAt: utc('2026-11-20T10:00:00Z'),
    });
    expect((await rows(mamaId, 'lesson.cancelled')).map((r) => r.dedupeKey)).toEqual(['cnl:1:cc:' + mamaId]);
    // link.ended cannot be muted by a parent at all
    await expect(settings.toggleMute(actor(mamaId, 'PARENT'), 'link.ended')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    // without a teacher context there is no copy (nothing to look the defaults up by)
    await notifications.schedule({
      type: 'lesson.summary',
      recipientId: petyaId,
      payload: {},
      dedupeKey: 'sum:5',
    });
    expect(await rows(papaId, 'lesson.summary')).toHaveLength(3); // sum:1, sum:3, sum:4
  });

  it('NTF-06: non-critical messages wait for the morning in the recipient zone; critical and reminders do not', async () => {
    ctx.clock.set('2026-10-19T20:30:00Z'); // 23:30 Minsk, 01:30 Yekaterinburg
    // a cancellation 13 h ahead may not be muted (48 h) but still waits for the morning (12 h); 11 h ahead goes now
    const in13h = await notifications.schedule({
      type: 'lesson.cancelled',
      recipientId: petyaId,
      payload: {},
      dedupeKey: 'q:13',
      teacherId: annaId,
      lessonStartsAt: utc('2026-10-20T09:30:00Z'),
    });
    expect(in13h!.dueAt).toEqual(utc('2026-10-20T05:00:00Z'));
    const in11h = await notifications.schedule({
      type: 'lesson.cancelled',
      recipientId: petyaId,
      payload: {},
      dedupeKey: 'q:11',
      teacherId: annaId,
      lessonStartsAt: utc('2026-10-20T07:30:00Z'),
    });
    expect(in11h!.dueAt).toEqual(utc('2026-10-19T20:30:00Z'));
    const copy = (await rows(papaId, 'lesson.cancelled')).find((r) => r.dedupeKey.startsWith('q:13'))!;
    expect(copy.dueAt).toEqual(utc('2026-10-20T03:00:00Z')); // 08:00 Yekaterinburg
    const late = await notifications.schedule({
      type: 'lesson.summary',
      recipientId: petyaId,
      payload: {},
      dedupeKey: 'q:1',
      teacherId: annaId,
    });
    expect(late!.dueAt).toEqual(utc('2026-10-20T05:00:00Z')); // 08:00 Minsk
    expect((await rows(papaId, 'lesson.summary')).find((r) => r.dedupeKey.startsWith('q:1'))!.dueAt).toEqual(
      utc('2026-10-20T03:00:00Z'),
    ); // 08:00 Yekaterinburg
    const urgent = await notifications.schedule({
      type: 'lesson.cancelled',
      recipientId: petyaId,
      payload: {},
      dedupeKey: 'q:2',
      lessonStartsAt: utc('2026-10-20T06:00:00Z'),
    });
    expect(urgent!.dueAt).toEqual(utc('2026-10-19T20:30:00Z'));
    const reminder = await notifications.schedule({
      type: 'lesson.reminder',
      recipientId: petyaId,
      payload: {},
      dedupeKey: 'q:3',
      dueAt: utc('2026-10-19T21:00:00Z'),
      keepTime: true,
    });
    expect(reminder!.dueAt).toEqual(utc('2026-10-19T21:00:00Z'));
    // the student switches quiet hours off → immediate
    await settings.toggleQuiet(actor(petyaId, 'STUDENT'));
    const now = await notifications.schedule({
      type: 'lesson.summary',
      recipientId: petyaId,
      payload: {},
      dedupeKey: 'q:4',
    });
    expect(now!.dueAt).toEqual(utc('2026-10-19T20:30:00Z'));
    await settings.setQuietHours(actor(petyaId, 'STUDENT'), '23:00', '07:30');
    const custom = await notifications.schedule({
      type: 'lesson.summary',
      recipientId: petyaId,
      payload: {},
      dedupeKey: 'q:5',
    });
    expect(custom!.dueAt).toEqual(utc('2026-10-20T04:30:00Z'));
    ctx.clock.set('2026-10-19T12:00:00Z');
  });

  it('5.13.3: reminders follow personal intervals; NTF-04: an unreachable student → parents stand in; NTF-09 → the teacher is warned; the digest goes once a day', async () => {
    ctx.clock.set('2026-10-19T12:00:00Z');
    const petya = actor(petyaId, 'STUDENT');
    await settings.toggleOffset(petya, 1440); // off → [60]
    await settings.toggleOffset(petya, 15); // [60, 15]
    await expect(async () => {
      await settings.toggleOffset(petya, 30);
      await settings.toggleOffset(petya, 120);
    }).rejects.toMatchObject({ code: 'VALIDATION_ERROR' }); // a fourth interval
    const { lesson } = await ctx.get(CreateLessonUseCase).execute(anna(), {
      target: { studentId: petyaId },
      startsAt: utc('2026-10-22T13:00:00Z'),
      durationMin: 60,
    });
    await drainOutbox(ctx, tdb);
    const petyaReminders = (await rows(petyaId, 'lesson.reminder')).filter((r) =>
      r.dedupeKey.includes(lesson.id),
    );
    expect(petyaReminders.map((r) => r.dueAt.toISOString()).sort()).toEqual([
      '2026-10-22T12:00:00.000Z',
      '2026-10-22T12:30:00.000Z',
      '2026-10-22T12:45:00.000Z',
    ]);
    const annaReminders = (await rows(annaId, 'lesson.reminder')).filter((r) =>
      r.dedupeKey.includes(lesson.id),
    );
    expect(annaReminders).toHaveLength(2); // the defaults: 24 h and 1 h
    // the student's bot becomes unreachable: with the teacher's opt-in, parents get the main message instead
    await ctx.get(OutboxService).publish({
      type: 'channel.unreachable',
      aggregateType: 'account',
      aggregateId: petyaId,
      payload: { accountId: petyaId, bot: 'student', error: 'bot was blocked by the user' },
    });
    await ctx
      .get(AccountRepository)
      .markBotChatUnreachable(petyaId, 'student', 'bot was blocked by the user');
    await drainOutbox(ctx, tdb);
    const warned = await rows(annaId, 'channel.unreachable');
    expect(warned).toHaveLength(1);
    expect(warned[0]!.payload).toMatchObject({ student: 'Петя Иванов' });
    await notifications.schedule({
      type: 'lesson.summary',
      recipientId: petyaId,
      payload: {},
      dedupeKey: 'via:0',
      teacherId: annaId,
    });
    expect((await rows(petyaId, 'lesson.summary')).some((r) => r.dedupeKey === 'via:0')).toBe(true); // opt-in is off: as usual
    await settings.toggleViaParent(anna());
    const main = await notifications.schedule({
      type: 'lesson.summary',
      recipientId: petyaId,
      payload: {},
      dedupeKey: 'via:1',
      teacherId: annaId,
    });
    // mama muted lesson.summary earlier (NTF-02 applies to stand-in rows too): papa gets the main row
    expect(main).toMatchObject({
      recipientId: papaId,
      route: 'via_parent',
      forAccountId: petyaId,
      ccOfId: null,
    });
    expect((await rows(petyaId, 'lesson.summary')).some((r) => r.dedupeKey === 'via:1')).toBe(false);
    expect(
      (await rows(papaId, 'lesson.summary')).some((r) => r.dedupeKey.startsWith('via:1:via_parent')),
    ).toBe(true);
    await settings.toggleViaParent(anna());
    // the digest: nothing before 08:00 Minsk, once after, never twice the same day
    const digest = ctx.get(DailyDigestJob);
    await ctx.get(CancelLessonUseCase).execute(anna(), { lessonId: lesson.id, reason: 'x', as: 'TEACHER' });
    await ctx.get(CreateLessonUseCase).execute(anna(), {
      target: { studentId: petyaId },
      startsAt: utc('2026-10-23T06:00:00Z'),
      durationMin: 60,
    });
    ctx.clock.set('2026-10-23T04:30:00Z'); // 07:30 Minsk
    expect(await digest.run()).toBe(0);
    ctx.clock.set('2026-10-23T05:10:00Z'); // 08:10 Minsk
    expect(await digest.run()).toBe(1);
    expect(await digest.run()).toBe(0);
    const sent = await rows(annaId, 'digest.daily');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({
      date: 'пт 23.10',
      count: 1,
      lessons: '09:00 Петя Иванов',
      requests: 0,
    });
    await settings.toggleDigest(anna());
    ctx.clock.set('2026-10-24T05:10:00Z');
    expect(await digest.run()).toBe(0);
    ctx.clock.set('2026-10-19T12:00:00Z');
  });
});
