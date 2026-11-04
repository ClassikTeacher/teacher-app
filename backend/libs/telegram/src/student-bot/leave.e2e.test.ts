import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DAY_MS } from '@shared/time/clock.js';
import { createTestContext, type TestContext } from '@test/app.js';
import { createBotHarness, type BotHarness } from '@test/bot.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount, nextTelegramUserId } from '@test/factories.js';
import { drainOutbox } from '@test/outbox.js';
import { linkStudent } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { notification } from '@modules/notifications/schema.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { ExpireLeaveRequestsJob } from '@modules/people/links/expire-leave-requests.job.js';
import { LeaveRequestRepository } from '@modules/people/links/leave-request.repository.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { ParentBot } from '../parent-bot/parent-bot.js';
import { TelegramModule } from '../telegram.module.js';
import { StudentBot } from './student-bot.js';

describe('UC-34 / UC-35: a student leaves a teacher — directly or with a parent’s consent (LINK-01…05)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let studentBot: BotHarness;
  let parentBot: BotHarness;
  let teacherId: string;
  let studentId: string;
  let momId: string;
  let dadId: string;
  const studentTg = nextTelegramUserId();
  const momTg = nextTelegramUserId();
  const dadTg = nextTelegramUserId();
  const student = () => ({ id: studentTg, first_name: 'Петя' });
  const mom = () => ({ id: momTg, first_name: 'Мария' });
  const dad = () => ({ id: dadTg, first_name: 'Олег' });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [PeopleModule, AccessModule, NotificationsModule, TelegramModule]);
    studentBot = createBotHarness(ctx.get(StudentBot), ctx.get(ActorResolver));
    parentBot = createBotHarness(ctx.get(ParentBot), ctx.get(ActorResolver));
    teacherId = (
      await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Анна', lastName: 'Петровна' })
    ).id;
    studentId = (
      await createAccount(tdb.txm, {
        telegramUserId: studentTg,
        roles: ['STUDENT'],
        firstName: 'Петя',
        lastName: 'Иванов',
      })
    ).id;
    momId = (await createAccount(tdb.txm, { telegramUserId: momTg, roles: ['PARENT'], firstName: 'Мария' }))
      .id;
    dadId = (await createAccount(tdb.txm, { telegramUserId: dadTg, roles: ['PARENT'], firstName: 'Олег' }))
      .id;
    for (const parentId of [momId, dadId]) {
      await ctx.get(FamilyLinkRepository).insert({
        parentId,
        studentId,
        invitedBy: teacherId,
        invitationId: null,
        confirmedAt: ctx.clock.now(),
      });
    }
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  const typeCodes = async (): Promise<Array<[string, string]>> =>
    (await tdb.db.select().from(notification)).map((n) => [n.typeCode, n.recipientId] as [string, string]);

  it('with parents: request → both parents asked (+48h reminder) → first answer wins → link ended → others told', async () => {
    const link = await linkStudent(ctx, teacherId, studentId);
    await studentBot.text(student(), '/menu');
    await studentBot.press(student(), '👩‍🏫 Мои учителя');
    await studentBot.press(student(), 'Анна Петровна');
    await studentBot.press(student(), '⛔ Прекратить занятия');
    await studentBot.text(student(), 'Слишком далеко ездить');
    expect(studentBot.tg.sentTexts(studentTg).at(-1)).toContain('запрос уйдёт ему');
    await studentBot.press(student(), 'Отправить родителям');
    expect(studentBot.tg.sentTexts(studentTg).at(-1)).toContain('Запрос отправлен родителям');
    expect((await ctx.get(TeacherStudentRepository).findById(link.id))?.status).toBe('active'); // LINK-04

    await drainOutbox(ctx, tdb);
    const codes = await typeCodes();
    expect(
      codes
        .filter(([c]) => c === 'link.leave_request')
        .map(([, r]) => r)
        .sort(),
    ).toEqual([dadId, momId].sort());
    expect(codes.filter(([c]) => c === 'link.leave_reminder')).toHaveLength(2);
    expect(codes.some(([, r]) => r === teacherId)).toBe(false); // LINK-05: the teacher is not told
    const request = (await ctx.get(LeaveRequestRepository).findPendingByLink(link.id))!;
    const reminder = (
      await tdb.db.select().from(notification).where(eq(notification.typeCode, 'link.leave_reminder'))
    )[0]!;
    expect(reminder.dueAt.getTime() - ctx.clock.now().getTime()).toBe(48 * 60 * 60 * 1000);

    // mom decides from the notification button; dad's late tap is told the request is closed (LINK-03)
    await parentBot.text(mom(), '/menu');
    await parentBot.press(mom(), '✅ Запросы');
    expect(parentBot.tg.sentTexts(momTg).at(-1)).toContain('хочет прекратить занятия у <b>Анна Петровна</b>');
    await parentBot.callback(mom(), `m:lr:ok:${request.id}`);
    expect(parentBot.tg.sentTexts(momTg).at(-1)).toContain('Вы согласились');
    await parentBot.callback(dad(), `m:lr:no:${request.id}`);
    expect(parentBot.tg.sentTexts(dadTg).at(-1)).toContain('уже закрыт');

    expect(await ctx.get(TeacherStudentRepository).findById(link.id)).toMatchObject({
      status: 'ended',
      endReason: 'left_by_student',
    });
    await drainOutbox(ctx, tdb);
    const after = await typeCodes();
    // the teacher learns the outcome (LINK-05); the student and dad get the decision instead of a second message
    expect(after.filter(([c]) => c === 'link.ended').map(([, r]) => r)).toEqual([teacherId]);
    expect(
      after
        .filter(([c]) => c === 'link.leave_decided')
        .map(([, r]) => r)
        .sort(),
    ).toEqual([dadId, studentId].sort());
    const reminders = await tdb.db
      .select()
      .from(notification)
      .where(eq(notification.typeCode, 'link.leave_reminder'));
    expect(reminders.every((r) => r.status === 'cancelled')).toBe(true);
  });

  it('without parents: reason → "Вы уверены?" → the link ends at once (LINK-01)', async () => {
    const solo = await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Вася' });
    const link = await linkStudent(ctx, teacherId, solo.id);
    const user = { id: solo.telegramUserId, first_name: 'Вася' };
    await studentBot.text(user, '/menu');
    await studentBot.press(user, '👩‍🏫 Мои учителя');
    await studentBot.press(user, 'Анна Петровна');
    await studentBot.press(user, '⛔ Прекратить занятия');
    await studentBot.text(user, 'Хочу другого учителя');
    expect(studentBot.tg.sentTexts(user.id).at(-1)).toContain('Вы уверены?');
    await studentBot.press(user, 'Да, прекратить');
    expect(studentBot.tg.sentTexts(user.id).at(-1)).toContain('завершены');
    expect(await ctx.get(TeacherStudentRepository).findById(link.id)).toMatchObject({
      status: 'ended',
      endReason: 'left_by_student',
      endMessage: 'Хочу другого учителя',
    });
  });

  it('a request without an answer for 7 days expires (UC-40); a declined request keeps the link active', async () => {
    // the pair already has an ended link from the first test: re-adding reopens it (5.8.4)
    const links = ctx.get(TeacherStudentRepository);
    const ended = (await links.findByPair(teacherId, studentId))!;
    const link = await links.update(ended.id, {
      status: 'active',
      endedAt: null,
      endReason: null,
      endMessage: null,
      startedAt: ctx.clock.now(),
    });
    await links.openPeriod(link.id, ctx.clock.now());
    await studentBot.text(student(), '/menu');
    await studentBot.press(student(), '👩‍🏫 Мои учителя');
    await studentBot.press(student(), 'Анна Петровна');
    await studentBot.press(student(), '⛔ Прекратить занятия');
    await studentBot.text(student(), 'Причина');
    await studentBot.press(student(), 'Отправить родителям');
    const request = (await ctx.get(LeaveRequestRepository).findPendingByLink(link.id))!;
    // a second request while one is pending is refused
    await studentBot.text(student(), '/menu');
    await studentBot.press(student(), '👩‍🏫 Мои учителя');
    await studentBot.press(student(), 'Анна Петровна');
    await studentBot.press(student(), '⛔ Прекратить занятия');
    await studentBot.text(student(), 'Ещё раз');
    await studentBot.press(student(), 'Отправить родителям');
    expect(studentBot.tg.sentTexts(studentTg).at(-1)).toContain('уже выполнено');

    ctx.clock.advance(8 * DAY_MS);
    try {
      expect(await ctx.get(ExpireLeaveRequestsJob).run()).toBe(1);
    } finally {
      ctx.clock.advance(-8 * DAY_MS);
    }
    expect((await ctx.get(LeaveRequestRepository).findById(request.id))?.status).toBe('expired');
    expect((await ctx.get(TeacherStudentRepository).findById(link.id))?.status).toBe('active');
    await drainOutbox(ctx, tdb);
    expect((await typeCodes()).some(([c, r]) => c === 'link.leave_expired' && r === studentId)).toBe(true);

    // declined: the student is told with the comment-free decision, the link stays active
    await studentBot.text(student(), '/menu');
    await studentBot.press(student(), '👩‍🏫 Мои учителя');
    await studentBot.press(student(), 'Анна Петровна');
    await studentBot.press(student(), '⛔ Прекратить занятия');
    await studentBot.text(student(), 'Снова');
    await studentBot.press(student(), 'Отправить родителям');
    await parentBot.text(dad(), '/menu');
    await parentBot.press(dad(), '✅ Запросы');
    await parentBot.press(dad(), '1 ❌');
    expect(parentBot.tg.sentTexts(dadTg).at(-2)).toContain('Вы не согласились');
    expect((await ctx.get(TeacherStudentRepository).findById(link.id))?.status).toBe('active');
    await drainOutbox(ctx, tdb);
    const decided = await tdb.db
      .select()
      .from(notification)
      .where(eq(notification.typeCode, 'link.leave_decided'));
    expect(
      decided.find(
        (n) => n.recipientId === studentId && (n.payload as { decision?: string }).decision === 'declined',
      ),
    ).toBeDefined();
  });

  it('5.8.3: a parent ends the child’s lessons from the teacher card; foreign request buttons are refused', async () => {
    const links = ctx.get(TeacherStudentRepository);
    const link = (await links.findByPair(teacherId, studentId))!; // still active after the declined request
    expect(link.status).toBe('active');
    // a stranger parent pressing a crafted request button learns nothing
    const strangerParent = await createAccount(tdb.txm, { roles: ['PARENT'], firstName: 'Чужой' });
    const stranger = { id: strangerParent.telegramUserId, first_name: 'Чужой' };
    await parentBot.callback(stranger, 'm:lr:ok:00000000-0000-7000-8000-000000000000');
    expect(parentBot.tg.sentTexts(stranger.id).at(-1)).toContain('устарела');

    await parentBot.text(mom(), '/menu');
    await parentBot.press(mom(), '👩‍🏫 Учителя ребёнка');
    await parentBot.press(mom(), 'Анна Петровна');
    await parentBot.press(mom(), '⛔ Завершить занятия');
    await parentBot.text(mom(), 'Переезжаем');
    expect(parentBot.tg.sentTexts(momTg).at(-1)).toContain('Завершить занятия Петя Иванов у Анна Петровна?');
    await parentBot.press(mom(), 'Завершить занятия');
    expect(parentBot.tg.sentTexts(momTg).at(-1)).toContain('завершены');
    expect(await links.findById(link.id)).toMatchObject({
      status: 'ended',
      endReason: 'ended_by_parent',
      endMessage: 'Переезжаем',
    });
    await drainOutbox(ctx, tdb);
    const rows = await tdb.db.select().from(notification).where(eq(notification.typeCode, 'link.ended'));
    const byParent = rows.filter(
      (n) => (n.payload as { reason?: string }).reason === 'родитель завершил занятия',
    );
    // mom acted; the student, dad and the teacher are told
    expect(byParent.map((n) => n.recipientId).sort()).toEqual([dadId, studentId, teacherId].sort());
  });
});
