import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@test/app.js';
import { createBotHarness, type BotHarness } from '@test/bot.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount, nextTelegramUserId } from '@test/factories.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TelegramModule } from '../telegram.module.js';
import { StaffBot } from './staff-bot.js';

describe('StaffBot skeleton: menu by roles, refusals, chat registration', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let h: BotHarness;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [PeopleModule, TelegramModule]);
    const accounts = ctx.get(AccountRepository);
    h = createBotHarness(ctx.get(StaffBot), ctx.get(ActorResolver), {
      registerChat: async (actor, chatId) => {
        await accounts.upsertBotChat(actor.account.id, 'staff', chatId);
      },
    });
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('shows the teacher sections to a teacher and registers the chat and commands', async () => {
    const tgId = nextTelegramUserId();
    const teacher = await createAccount(tdb.txm, { telegramUserId: tgId, roles: ['TEACHER'] });
    const user = { id: tgId, first_name: 'Анна' };

    await h.text(user, '/start');
    const labels = h.tg
      .lastKeyboard(user.id)
      .flat()
      .map((b) => b.text);
    expect(labels).toEqual(expect.arrayContaining(['👥 Ученики', '⚙️ Настройки', '📅 Сегодня / Неделя']));
    expect(labels).not.toContain('🛠 Администрирование');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('учитель');

    const commands = h.tg.calls.find((c) => c.method === 'setMyCommands');
    expect(commands?.payload['scope']).toEqual({ type: 'chat', chat_id: tgId });
    expect(await ctx.get(AccountRepository).findBotChat(teacher.id, 'staff')).toMatchObject({
      chatId: tgId,
      isReachable: true,
    });

    await h.press(user, '📊 Журналы и отчёты');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('появится в следующих версиях');
    const edits = h.tg.calls.filter((c) => c.method === 'editMessageText');
    expect(edits.length).toBeGreaterThan(0); // menu edited in place, not re-sent

    await h.press(user, '◀️ Назад');
    expect(h.tg.sentTexts(user.id).at(-1)).toContain('Главное меню');
  });

  it('shows the admin section to admins and the admins entry only to the super admin', async () => {
    const adminTg = nextTelegramUserId();
    await createAccount(tdb.txm, { telegramUserId: adminTg, roles: ['ADMIN', 'TEACHER'] });
    const admin = { id: adminTg, first_name: 'Админ' };
    await h.text(admin, '/menu');
    expect(h.tg.findButton('🛠 Администрирование', adminTg)).toBeDefined();
    await h.press(admin, '🛠 Администрирование');
    let labels = h.tg
      .lastKeyboard(adminTg)
      .flat()
      .map((b) => b.text);
    expect(labels).toEqual(expect.arrayContaining(['👩‍🏫 Учителя', '🧾 Аудит']));
    expect(labels).not.toContain('👑 Администраторы');

    const saTg = nextTelegramUserId();
    await createAccount(tdb.txm, { telegramUserId: saTg, roles: ['SUPER_ADMIN'] });
    const sa = { id: saTg, first_name: 'СА' };
    await h.text(sa, '/menu');
    expect(h.tg.findButton('👥 Ученики', saTg)).toBeUndefined();
    await h.press(sa, '🛠 Администрирование');
    labels = h.tg
      .lastKeyboard(saTg)
      .flat()
      .map((b) => b.text);
    expect(labels).toContain('👑 Администраторы');
  });

  it('refuses strangers, blocked and not-yet-onboarded accounts with a pointer to AuthBot', async () => {
    const stranger = { id: nextTelegramUserId(), first_name: 'Гость' };
    await h.text(stranger, '/start');
    expect(h.tg.sentTexts(stranger.id).at(-1)).toContain('примите приглашение');
    expect(h.tg.findButton(/служебный бот/, stranger.id)?.url).toBe('https://t.me/TestAuthBot');

    const blockedTg = nextTelegramUserId();
    await createAccount(tdb.txm, { telegramUserId: blockedTg, roles: ['TEACHER'], status: 'blocked' });
    await h.text({ id: blockedTg, first_name: 'Б' }, '/start');
    expect(h.tg.sentTexts(blockedTg).at(-1)).toContain('Доступ ограничен');

    const onboardingTg = nextTelegramUserId();
    await createAccount(tdb.txm, { telegramUserId: onboardingTg, roles: ['TEACHER'], status: 'onboarding' });
    await h.text({ id: onboardingTg, first_name: 'О' }, '/start');
    expect(h.tg.sentTexts(onboardingTg).at(-1)).toContain('завершите регистрацию');

    const parentTg = nextTelegramUserId();
    await createAccount(tdb.txm, { telegramUserId: parentTg, roles: ['PARENT'] });
    await h.text({ id: parentTg, first_name: 'Р' }, '/start');
    expect(h.tg.sentTexts(parentTg).at(-1)).toContain('для учителей и администраторов');
  });

  it('drops duplicate update ids when a dedup hook is provided', async () => {
    const seen = new Set<number>();
    const dedup = createBotHarness(ctx.get(StaffBot), ctx.get(ActorResolver), {
      isFreshUpdate: async (id) => !seen.has(id) && Boolean(seen.add(id)),
    });
    const user = { id: nextTelegramUserId(), first_name: 'X' };
    const update = dedup.tg.textUpdate(user, '/start');
    await dedup.handle(update);
    await dedup.handle(update);
    expect(dedup.tg.sentTexts(user.id)).toHaveLength(1);
  });
});
