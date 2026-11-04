import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@test/app.js';
import { createBotHarness, type BotHarness } from '@test/bot.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount, nextTelegramUserId } from '@test/factories.js';
import { AccessModule } from '@modules/access/access.module.js';
import { FeatureService } from '@modules/access/features/feature.service.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TelegramModule } from '../../telegram.module.js';
import { StaffBot } from '../staff-bot.js';

describe('StaffBot admin section (UC-04, UC-07, UC-08) and section authorization', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let h: BotHarness;
  let adminTg: number;
  let teacherTg: number;
  let teacherId: string;
  const admin = () => ({ id: adminTg, first_name: 'Админ', username: 'admin' });
  const teacher = () => ({ id: teacherTg, first_name: 'Анна', username: 'anna' });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [PeopleModule, AccessModule, TelegramModule]);
    h = createBotHarness(ctx.get(StaffBot), ctx.get(ActorResolver));
    adminTg = nextTelegramUserId();
    teacherTg = nextTelegramUserId();
    await createAccount(tdb.txm, { telegramUserId: adminTg, roles: ['ADMIN'], firstName: 'Админ' });
    teacherId = (
      await createAccount(tdb.txm, {
        telegramUserId: teacherTg,
        roles: ['TEACHER'],
        firstName: 'Анна',
        lastName: 'П',
      })
    ).id;
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('UC-04: admin invites a teacher from the bot and gets a forwardable card with the AuthBot link', async () => {
    await h.text(admin(), '/menu');
    await h.press(admin(), '🛠 Администрирование');
    await h.press(admin(), '👩‍🏫 Учителя');
    expect(h.tg.sentTexts(adminTg).at(-1)).toContain('Учителя');
    await h.press(admin(), '✉️ Пригласить учителя');
    await h.text(admin(), 'Иван Иванов');
    const card = h.tg.sentTexts(adminTg).at(-1)!;
    expect(card).toContain('Приглашение на платформу');
    expect(card).toContain('Иван Иванов');
    expect(card).toMatch(/https:\/\/t\.me\/TestAuthBot\?start=[A-Za-z0-9_-]{43}/);
    expect(h.tg.findButton(/Открыть ссылку/, adminTg)?.url).toContain('t.me/TestAuthBot?start=');
    await h.press(admin(), 'Отозвать приглашение');
    expect(h.tg.sentTexts(adminTg).at(-1)).toContain('Пока нет ожидающих приглашений');
  });

  it('UC-07: switching a feature off removes the section from the teacher menu immediately', async () => {
    await h.text(teacher(), '/menu');
    expect(h.tg.findButton('📚 Материалы', teacherTg)).toBeDefined();

    await h.text(admin(), '/menu');
    await h.press(admin(), '🛠 Администрирование');
    await h.press(admin(), '👩‍🏫 Учителя');
    await h.press(admin(), /Анна П/);
    await h.press(admin(), '🎚 Фичи и лимиты');
    expect(h.tg.sentTexts(adminTg).at(-1)).toContain('Фичи и лимиты: Анна П');
    await h.press(admin(), /🟢 Файловое хранилище/);
    expect(h.tg.findButton(/⚪️ Файловое хранилище ✎/, adminTg)).toBeDefined();
    expect(h.tg.findButton(/⚪️ Материалы и подборки ⛓/, adminTg)).toBeDefined();

    const features = await ctx.get(FeatureService).resolve(teacherId);
    expect(features.get('storage')).toMatchObject({ enabled: false, reason: 'personal' });
    expect(features.get('materials')).toMatchObject({ enabled: false, reason: 'dependency' });

    await h.text(teacher(), '/menu');
    expect(h.tg.findButton('📚 Материалы', teacherTg)).toBeUndefined();
    expect(h.tg.findButton('📝 Задания', teacherTg)).toBeDefined();
    // crafted callback into a disabled section is refused
    await h.callback(teacher(), 'm:open:materials');
    expect(h.tg.sentTexts(teacherTg).at(-2)).toContain('нет прав');

    await h.press(admin(), /Квота хранилища/);
    await h.text(admin(), '512');
    expect(h.tg.sentTexts(adminTg).at(-1)).toContain('Лимит сохранён');
    expect(await ctx.get(FeatureService).limit(teacherId, 'storage', 'quotaBytes')).toBe(512 * 1024 * 1024);
  });

  it('UC-08: admin blocks a teacher with a reason and a lesson policy; the teacher is refused afterwards', async () => {
    await h.text(admin(), '/menu');
    await h.press(admin(), '🛠 Администрирование');
    await h.press(admin(), '👩‍🏫 Учителя');
    await h.press(admin(), /Анна П/);
    await h.press(admin(), '⛔ Заблокировать');
    await h.text(admin(), 'Жалобы учеников');
    await h.press(admin(), /Отменить будущие занятия/);
    await h.text(admin(), 'Занятия отменены администрацией');
    expect(h.tg.sentTexts(adminTg).at(-1)).toContain('Подтвердите блокировку');
    await h.press(admin(), 'Заблокировать');
    expect(h.tg.sentTexts(adminTg).at(-1)).toContain('заблокирован');
    expect((await ctx.get(AccountRepository).findById(teacherId))?.status).toBe('blocked');

    await h.text(teacher(), '/menu');
    expect(h.tg.sentTexts(teacherTg).at(-1)).toContain('Доступ ограничен');
    // a refused button press is answered with an alert instead of hanging
    await h.callback(teacher(), 'm:main');
    expect(h.tg.calls.at(-1)).toMatchObject({ method: 'answerCallbackQuery', payload: { show_alert: true } });

    await h.press(admin(), '◀️ Назад');
    await h.press(admin(), '✅ Разблокировать');
    expect((await ctx.get(AccountRepository).findById(teacherId))?.status).toBe('active');
  });

  it('refuses crafted admin callbacks from a teacher and a menu press cancels an active dialog', async () => {
    await h.callback(teacher(), 's:teachers:list');
    expect(h.tg.calls.at(-1)).toMatchObject({ method: 'answerCallbackQuery' });
    expect(String(h.tg.calls.at(-1)?.payload['text'])).toContain('нет прав');
    await h.callback(teacher(), 'm:open:teachers');
    expect(h.tg.sentTexts(teacherTg).at(-2)).toContain('нет прав');
    expect(h.tg.sentTexts(teacherTg).at(-1)).toContain('Главное меню');

    await h.text(admin(), '/menu');
    await h.press(admin(), '🛠 Администрирование');
    await h.press(admin(), '🔎 Пользователи');
    expect(h.tg.sentTexts(adminTg).at(-1)).toContain('Поиск пользователя');
    await h.press(admin(), '◀️ Назад'); // navigation cancels the search dialog
    await h.text(admin(), 'Анна');
    expect(h.tg.sentTexts(adminTg).at(-1)).not.toContain('Найдено');
  });
});
