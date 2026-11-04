import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '@test/app.js';
import { createBotHarness, type BotHarness } from '@test/bot.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount, nextTelegramUserId } from '@test/factories.js';
import { issueParentInvitation, linkStudent } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { consent } from '@modules/identity/schema.js';
import { outboxEvent } from '@modules/outbox/schema.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TelegramModule } from '../telegram.module.js';
import { ParentBot } from './parent-bot.js';

describe('ParentBot: /start <token> → confirm → questionnaire → children (UC-11 steps 3–4)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let h: BotHarness;
  let teacherId: string;
  let studentId: string;
  let studentTg: number;
  let accounts: AccountRepository;
  let family: FamilyLinkRepository;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [PeopleModule, AccessModule, TelegramModule]);
    h = createBotHarness(ctx.get(ParentBot), ctx.get(ActorResolver));
    accounts = ctx.get(AccountRepository);
    family = ctx.get(FamilyLinkRepository);
    teacherId = (
      await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Анна', lastName: 'Петровна' })
    ).id;
    const student = await createAccount(tdb.txm, {
      roles: ['STUDENT'],
      firstName: 'Петя',
      lastName: 'Иванов',
    });
    studentId = student.id;
    studentTg = student.telegramUserId;
    await linkStudent(ctx, teacherId, studentId);
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('a new parent confirms, answers the questionnaire and consents for the child; the family link is active', async () => {
    const token = await issueParentInvitation(ctx, teacherId, studentId);
    const user = { id: nextTelegramUserId(), first_name: 'Мария', last_name: 'Иванова' };
    await h.text(user, `/start ${token}`);
    const card = h.tg.sentTexts(user.id).at(-1)!;
    expect(card).toContain('Петя Иванов');
    expect(card).toContain('Анна Петровна');
    await h.press(user, '✅ Да, я родитель');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Регистрация, шаг 1');
    await h.press(user, /Оставить: Мария Иванова/);
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Шаг 2');
    await h.press(user, 'Europe/Minsk');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('законный представитель ученика <b>Петя Иванов</b>');
    await h.press(user, 'Принимаю');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Вы привязаны к ученику Петя Иванов');

    const account = (await accounts.findByTelegramUserId(user.id))!;
    expect(account.status).toBe('active');
    expect(await accounts.activeRoles(account.id)).toEqual(['PARENT']);
    expect(await accounts.findBotChat(account.id, 'parent')).toMatchObject({ chatId: user.id });
    const link = await family.findActive(account.id, studentId);
    expect(link).toMatchObject({ status: 'active', invitedBy: teacherId });
    const consents = await tdb.db.select().from(consent).where(eq(consent.accountId, account.id));
    expect(consents.map((c) => c.onBehalfOf).sort()).toEqual([null, studentId].sort());
    const events = await tdb.db.select().from(outboxEvent).where(eq(outboxEvent.aggregateId, link!.id));
    expect(events.map((e) => e.eventType)).toEqual(['family.activated']);

    await h.text(user, '/menu');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Главное меню');
    await h.press(user, '👧 Дети');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('выбран: Петя Иванов');
    expect(h.tg.findButton(/✅ Петя Иванов/, user.id)).toBeDefined();

    // a second link to the same child is refused up front
    const again = await issueParentInvitation(ctx, teacherId, studentId);
    await h.text(user, `/start ${again}`);
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('уже привязаны');
  });

  it('refuses the student opening their own parent link (UC-11 3в) and strangers without a link', async () => {
    const token = await issueParentInvitation(ctx, teacherId, studentId);
    await h.text({ id: studentTg, first_name: 'Петя' }, `/start ${token}`);
    expect(h.tg.sentTexts(studentTg).at(-1)).toContain('адресовано родителю');
    const stranger = { id: nextTelegramUserId(), first_name: 'Гость' };
    await h.text(stranger, '/menu');
    expect(h.tg.sentTexts(stranger.id).at(-1)).toContain('ссылку-приглашение от учителя');
  });

  it('an existing parent adds a second child without onboarding and switches between children (3а)', async () => {
    const parent = await createAccount(tdb.txm, { roles: ['PARENT'], firstName: 'Олег' });
    const user = { id: parent.telegramUserId, first_name: 'Олег' };
    const second = await createAccount(tdb.txm, {
      roles: ['STUDENT'],
      firstName: 'Маша',
      lastName: 'Иванова',
    });
    await linkStudent(ctx, teacherId, second.id);
    for (const child of [studentId, second.id]) {
      const token = await issueParentInvitation(ctx, teacherId, child);
      await h.text(user, `/start ${token}`);
      await h.press(user, '✅ Да, я родитель');
      expect(h.tg.sentTexts(user.id).at(-1)).toContain('Вы привязаны');
    }
    expect(await family.listActiveByParent(parent.id)).toHaveLength(2);
    await h.text(user, '/menu');
    await h.press(user, '👧 Дети');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('выбран: Петя Иванов');
    await h.press(user, 'Маша Иванова');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('выбран: Маша Иванова');
    expect(h.tg.findButton(/✅ Маша Иванова/, user.id)).toBeDefined();
  });

  it('a fifth parent is refused with the limit message (5.4.3)', async () => {
    const child = await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Коля' });
    await linkStudent(ctx, teacherId, child.id);
    for (let i = 0; i < 4; i += 1) {
      const p = await createAccount(tdb.txm, { roles: ['PARENT'] });
      const token = await issueParentInvitation(ctx, teacherId, child.id);
      await h.text({ id: p.telegramUserId, first_name: 'P' }, `/start ${token}`);
      await h.press({ id: p.telegramUserId, first_name: 'P' }, '✅ Да, я родитель');
    }
    const fifth = await createAccount(tdb.txm, { roles: ['PARENT'] });
    const token = await issueParentInvitation(ctx, teacherId, child.id);
    await h.text({ id: fifth.telegramUserId, first_name: 'P' }, `/start ${token}`);
    expect(h.tg.sentTexts(fifth.telegramUserId).at(-1)).toContain('уже четыре родителя'); // told before the questionnaire
    expect(h.tg.findButton(/Да, я родитель/, fifth.telegramUserId)).toBeUndefined();
    expect(await family.listActiveByStudent(child.id)).toHaveLength(4);
  });

  it('a parent link of a teacher who has since parted with the student is invalid (8.0)', async () => {
    const other = await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Олег' });
    const child = await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Лена' });
    const token = await issueParentInvitation(ctx, other.id, child.id); // no active teacher–student link at all
    const user = { id: nextTelegramUserId(), first_name: 'Мама' };
    await h.text(user, `/start ${token}`);
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('недействительно');
  });

  it('a staff account still in onboarding is sent back to AuthBot instead of the parent questionnaire (M1-M2 review M-1)', async () => {
    const half = await createAccount(tdb.txm, { roles: ['TEACHER'], status: 'onboarding', firstName: 'Ира' });
    const user = { id: half.telegramUserId, first_name: 'Ира' };
    const token = await issueParentInvitation(ctx, teacherId, studentId);
    await h.text(user, `/start ${token}`);
    await h.press(user, '✅ Да, я родитель');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Сначала завершите регистрацию в служебном боте');
    expect((await accounts.findById(half.id))!.status).toBe('onboarding');
    expect(await accounts.activeRoles(half.id)).toEqual(['TEACHER']);
  });
});
