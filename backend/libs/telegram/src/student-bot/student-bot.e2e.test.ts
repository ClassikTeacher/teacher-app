import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '@test/app.js';
import { createBotHarness, type BotHarness } from '@test/bot.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount, nextTelegramUserId } from '@test/factories.js';
import { issueParentInvitation, issueStudentInvitation, linkStudent, PHYSICS_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { InviteStaffUseCase } from '@modules/identity/invite-staff.use-case.js';
import { consent, invitation } from '@modules/identity/schema.js';
import { outboxEvent } from '@modules/outbox/schema.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { StudentProfileRepository } from '@modules/people/student-profile.repository.js';
import { TelegramModule } from '../telegram.module.js';
import { StudentBot } from './student-bot.js';

describe('StudentBot: /start <token> → accept → questionnaire → menu (UC-10 steps 5–7)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let h: BotHarness;
  let teacherId: string;
  let accounts: AccountRepository;
  let links: TeacherStudentRepository;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [PeopleModule, AccessModule, TelegramModule]);
    h = createBotHarness(ctx.get(StudentBot), ctx.get(ActorResolver), {
      registerChat: (actor, chatId) =>
        ctx
          .get(AccountRepository)
          .upsertBotChat(actor.account.id, 'student', chatId)
          .then(() => undefined),
    });
    accounts = ctx.get(AccountRepository);
    links = ctx.get(TeacherStudentRepository);
    teacherId = (
      await createAccount(tdb.txm, {
        roles: ['TEACHER'],
        firstName: 'Анна',
        lastName: 'Петровна',
        username: 'anna',
      })
    ).id;
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('walks a new student through the invitation card and the questionnaire; the link becomes active', async () => {
    const { token, link } = await issueStudentInvitation(ctx, teacherId, { grade: '9' });
    const user = { id: nextTelegramUserId(), first_name: 'Петя', last_name: 'Иванов' };

    await h.text(user, `/start ${token}`);
    const card = h.tg.sentTexts(user.id).at(-1)!;
    expect(card).toContain('Анна Петровна');
    expect(card).toContain('Математика');
    await h.press(user, '✅ Принять');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Регистрация, шаг 1');
    await h.text(user, 'Пётр Иванов');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Шаг 2');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Сейчас: 9'); // grade typed by the teacher
    await h.text(user, '9Б');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Шаг 3');
    await h.press(user, 'Europe/Moscow');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Последний шаг');
    await h.press(user, 'Принимаю');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Вы занимаетесь у Анна Петровна');

    const account = (await accounts.findByTelegramUserId(user.id))!;
    expect(account).toMatchObject({
      status: 'active',
      firstName: 'Пётр',
      lastName: 'Иванов',
      timezone: 'Europe/Moscow',
    });
    expect(await accounts.activeRoles(account.id)).toEqual(['STUDENT']);
    expect(await accounts.findBotChat(account.id, 'student')).toMatchObject({
      chatId: user.id,
      isReachable: true,
    });
    expect(await ctx.get(StudentProfileRepository).find(account.id)).toMatchObject({ grade: '9Б' });
    const active = (await links.findById(link.id))!;
    expect(active).toMatchObject({ status: 'active', studentId: account.id, maxLessonsPerWeek: 2 });
    expect(await links.listPeriods(link.id)).toHaveLength(1);
    expect(await tdb.db.select().from(consent).where(eq(consent.accountId, account.id))).toHaveLength(1);
    const events = await tdb.db.select().from(outboxEvent).where(eq(outboxEvent.aggregateId, link.id));
    expect(events.map((e) => e.eventType)).toEqual(['link.activated']);

    await h.text(user, '/menu');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Главное меню');
    await h.press(user, '👩‍🏫 Мои учителя');
    await h.press(user, 'Анна Петровна');
    const teacherCard = h.tg.sentTexts(user.id).at(-1)!;
    expect(teacherCard).toContain('Математика');
    expect(teacherCard).toContain('Лимит занятий в неделю: 2');
    expect(h.tg.findButton(/Написать учителю/, user.id)?.url).toBe('https://t.me/anna');
    await h.press(user, '📅 Расписание').catch(() => undefined);

    // a second invitation from the same teacher is refused up front (UC-10 5б)
    const again = await issueStudentInvitation(ctx, teacherId);
    await h.text(user, `/start ${again.token}`);
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('уже занимаетесь');
  });

  it('declining burns the token and marks the card declined (UC-10 5а)', async () => {
    const { token, link } = await issueStudentInvitation(ctx, teacherId);
    const user = { id: nextTelegramUserId(), first_name: 'Вася' };
    await h.text(user, `/start ${token}`);
    await h.press(user, '❌ Отклонить');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('отклонено');
    expect((await links.findById(link.id))?.status).toBe('declined');
    const [inv] = await tdb.db.select().from(invitation).where(eq(invitation.id, link.invitationId!));
    expect(inv).toMatchObject({ status: 'used', usedBy: null });
    expect(await accounts.findByTelegramUserId(user.id)).toBeNull(); // no account for a stranger who declined
    await h.text(user, `/start ${token}`);
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('уже использовано');
  });

  it('an existing active account joins without a second questionnaire; an ended link is reopened', async () => {
    const otherTeacher = await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Олег' });
    const user = { id: otherTeacher.telegramUserId, first_name: 'Олег' };
    const first = await issueStudentInvitation(ctx, teacherId, { subjectIds: [PHYSICS_ID] });
    await h.text(user, `/start ${first.token}`);
    await h.press(user, '✅ Принять');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Вы занимаетесь у');
    expect(await accounts.activeRoles(otherTeacher.id)).toEqual(
      expect.arrayContaining(['TEACHER', 'STUDENT']),
    );

    await links.update(first.link.id, {
      status: 'ended',
      endedAt: ctx.clock.now(),
      endReason: 'removed_by_teacher',
    });
    await links.closePeriod(first.link.id, ctx.clock.now(), 'removed_by_teacher');
    const second = await issueStudentInvitation(ctx, teacherId, { maxLessonsPerWeek: null });
    await h.text(user, `/start ${second.token}`);
    await h.press(user, '✅ Принять');
    const reopened = (await links.findById(first.link.id))!;
    expect(reopened).toMatchObject({ status: 'active', maxLessonsPerWeek: null, endReason: null });
    expect(await links.listPeriods(first.link.id)).toHaveLength(2);
    expect((await links.findById(second.link.id))?.status).toBe('cancelled');
  });

  it('redirects foreign links, refuses strangers and blocked accounts', async () => {
    const student = await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Саша' });
    await linkStudent(ctx, teacherId, student.id);
    const parentToken = await issueParentInvitation(ctx, teacherId, student.id);
    const user = { id: nextTelegramUserId(), first_name: 'Гость' };
    await h.text(user, `/start ${parentToken}`);
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('для родителя');
    expect(h.tg.findButton(/бот родителя/, user.id)?.url).toBe('https://t.me/TestParentBot');

    const admin = await createAccount(tdb.txm, { roles: ['ADMIN'] });
    const staff = await ctx
      .get(InviteStaffUseCase)
      .execute(
        { accountId: admin.id, roles: ['ADMIN'], status: 'active', source: 'bot' },
        { role: 'TEACHER' },
      );
    await h.text(user, `/start ${staff.token}`);
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('служебном боте');
    expect(h.tg.findButton(/служебный бот/, user.id)?.url).toBe('https://t.me/TestAuthBot');

    await h.text(user, '/start');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('ссылку-приглашение от учителя');
    await h.text(user, 'привет');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('ссылку-приглашение от учителя');

    await h.text({ id: student.telegramUserId, first_name: 'Саша' }, '/menu');
    expect(h.tg.sentTexts(student.telegramUserId).at(-1)).toContain('Главное меню');
    await accounts.update(student.id, { status: 'blocked' });
    await h.text({ id: student.telegramUserId, first_name: 'Саша' }, '/menu');
    expect(h.tg.sentTexts(student.telegramUserId).at(-1)).toContain('Доступ ограничен');
    const { token } = await issueStudentInvitation(ctx, teacherId);
    await h.text({ id: student.telegramUserId, first_name: 'Саша' }, `/start ${token}`);
    expect(h.tg.sentTexts(student.telegramUserId).at(-1)).toContain('Доступ ограничен');
  });

  it('does not record a StudentBot chat for accounts without the student role', async () => {
    const teacher = await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Нина' });
    await h.text({ id: teacher.telegramUserId, first_name: 'Нина' }, '/start');
    expect(h.tg.sentTexts(teacher.telegramUserId).at(-1)).toContain('для учеников');
    expect(await accounts.findBotChat(teacher.id, 'student')).toBeNull();
  });

  it('a teacher who has not finished the staff questionnaire is not activated by a student link (M1-M2 review M-1)', async () => {
    const { token } = await issueStudentInvitation(ctx, teacherId);
    const tg = nextTelegramUserId();
    const half = await createAccount(tdb.txm, {
      telegramUserId: tg,
      roles: ['TEACHER'],
      status: 'onboarding',
      firstName: 'Олег',
    });
    const user = { id: tg, first_name: 'Олег' };
    await h.text(user, `/start ${token}`);
    await h.press(user, '✅ Принять');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Сначала завершите регистрацию в служебном боте');
    expect((await accounts.findById(half.id))!.status).toBe('onboarding');
  });
});
