import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { HOUR_MS } from '@shared/time/clock.js';
import { createTestContext, type TestContext } from '@test/app.js';
import { createBotHarness, type BotHarness } from '@test/bot.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount, nextTelegramUserId } from '@test/factories.js';
import type { Actor } from '@modules/access/actor.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { consent } from '@modules/identity/schema.js';
import { InviteStaffUseCase } from '@modules/identity/invite-staff.use-case.js';
import { outboxEvent } from '@modules/outbox/schema.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { TelegramModule } from '../telegram.module.js';
import { AuthBot } from './auth-bot.js';

describe('AuthBot: invitation → questionnaire → active account (UC-04, UC-05)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let h: BotHarness;
  let admin: Actor;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [PeopleModule, TelegramModule]);
    h = createBotHarness(ctx.get(AuthBot), ctx.get(ActorResolver));
    const adminRow = await createAccount(tdb.txm, { roles: ['ADMIN'] });
    admin = { accountId: adminRow.id, roles: ['ADMIN'], status: 'active', source: 'bot' };
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('walks a new teacher through onboarding and hands over to StaffBot', async () => {
    const issued = await ctx.get(InviteStaffUseCase).execute(admin, { role: 'TEACHER' });
    const user = { id: nextTelegramUserId(), first_name: 'Анна', last_name: 'Петровна', username: 'anna' };

    await h.text(user, `/start ${issued.token}`);
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Регистрация, шаг 1');
    expect(h.tg.findButton(/Оставить: Анна Петровна/, user.id)).toBeDefined();

    await h.text(user, 'Анна Иванова');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Шаг 2');
    await h.press(user, /Математика/);
    await h.press(user, /Физика/);
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Выбрано: 2');
    expect(h.tg.findButton(/✅ Математика/, user.id)).toBeDefined();
    await h.press(user, /✅ Физика/);
    await h.press(user, 'Готово');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Шаг 3');

    await h.press(user, 'Europe/Moscow');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Шаг 4');
    await h.text(user, 'много');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('от 15 до 480');
    await h.press(user, '90');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Шаг 5');
    await h.text(user, 'Приношу извинения, занятие переносится.');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Последний шаг');
    await h.press(user, 'Принимаю');

    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Готово');
    expect(h.tg.findButton(/рабочий бот/, user.id)?.url).toBe('https://t.me/TestStaffBot');

    const account = await ctx.get(AccountRepository).findByTelegramUserId(user.id);
    expect(account).toMatchObject({
      status: 'active',
      firstName: 'Анна',
      lastName: 'Иванова',
      timezone: 'Europe/Moscow',
    });
    const profile = await ctx.get(TeacherProfileRepository).find(account!.id);
    expect(profile).toMatchObject({
      defaultDurationMin: 90,
      defaultNoticeText: 'Приношу извинения, занятие переносится.',
    });
    expect(profile!.subjectIds).toHaveLength(1);
    expect(await tdb.db.select().from(consent).where(eq(consent.accountId, account!.id))).toHaveLength(1);
    const events = await tdb.db.select().from(outboxEvent).where(eq(outboxEvent.aggregateId, account!.id));
    expect(events.map((e) => e.eventType).sort()).toEqual(['role.granted', 'teacher.onboarded']);

    // the menu is edited in place: roughly one new message per step, not one per button press
    const sends = h.tg.calls.filter((c) => c.method === 'sendMessage' && c.payload['chat_id'] === user.id);
    expect(sends.length).toBeLessThanOrEqual(8);

    await h.text(user, '/start');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('уже зарегистрированы');
  });

  it('explains invalid, expired and misaddressed links without consuming anything', async () => {
    const user = { id: nextTelegramUserId(), first_name: 'Гость' };
    await h.text(user, '/start not-a-token');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('недействительно');

    const bound = await ctx
      .get(InviteStaffUseCase)
      .execute(admin, { role: 'TEACHER', targetTelegramUserId: 1 });
    await h.text(user, `/start ${bound.token}`);
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('адресовано не вам');

    const expiring = await ctx.get(InviteStaffUseCase).execute(admin, { role: 'TEACHER' });
    ctx.clock.advance(73 * HOUR_MS);
    await h.text(user, `/start ${expiring.token}`);
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('истёк');
    ctx.clock.advance(-73 * HOUR_MS);

    await h.text(user, '/start');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('ссылку-приглашение');
  });

  it('asks an existing account to confirm before adding the role (INV-04); /cancel aborts', async () => {
    const parentTg = nextTelegramUserId();
    await createAccount(tdb.txm, { telegramUserId: parentTg, roles: ['PARENT'], firstName: 'Олег' });
    const user = { id: parentTg, first_name: 'Олег', username: 'oleg' };
    const issued = await ctx.get(InviteStaffUseCase).execute(admin, { role: 'TEACHER' });

    await h.text(user, `/start ${issued.token}`);
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Добавить её');
    await h.press(user, 'Да');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Регистрация, шаг 1');
    await h.text(user, '/cancel');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('прерван');

    // the role is already granted, so /start without a token resumes the questionnaire (no dead end)
    await h.text(user, '/start');
    expect(h.tg.sentTexts(user.id).at(-2)).toContain('Продолжим регистрацию');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Регистрация, шаг 1');
  });

  it('requires a Telegram username before accepting the consent (AUTH-04)', async () => {
    const saRow = await createAccount(tdb.txm, { roles: ['SUPER_ADMIN'] });
    const sa: Actor = { accountId: saRow.id, roles: ['SUPER_ADMIN'], status: 'active', source: 'bot' };
    const issued = await ctx
      .get(InviteStaffUseCase)
      .execute(sa, { role: 'ADMIN', targetTelegramUserId: 777 });
    const noUsername = { id: 777, first_name: 'Без', last_name: 'Юзернейма' };
    await h.text(noUsername, `/start ${issued.token}`);
    await h.press(noUsername, /Оставить/);
    await h.press(noUsername, 'Europe/Minsk');
    expect(h.tg.sentTexts(777).at(-1)).toContain('Последний шаг');
    await h.press(noUsername, 'Принимаю');
    expect(h.tg.sentTexts(777).at(-1)).toContain('нужен username');
    expect((await ctx.get(AccountRepository).findByTelegramUserId(777))?.status).toBe('onboarding');

    await h.press({ ...noUsername, username: 'now_set' }, 'Принимаю');
    expect(h.tg.sentTexts(777).at(-1)).toContain('Готово');
    expect(await ctx.get(AccountRepository).findByTelegramUserId(777)).toMatchObject({
      status: 'active',
      username: 'now_set',
    });
  });
});
