import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@test/app.js';
import { createBotHarness, type BotHarness } from '@test/bot.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount, nextTelegramUserId } from '@test/factories.js';
import { MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { AvailabilityRepository } from '@modules/schedule/availability/availability.repository.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { TelegramModule } from '../../telegram.module.js';
import { StaffBot } from '../staff-bot.js';

describe('M3-03: availability windows in StaffBot settings', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let h: BotHarness;
  let teacherId: string;
  const tg = nextTelegramUserId();
  const teacher = () => ({ id: tg, first_name: 'Анна' });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [PeopleModule, AccessModule, ScheduleModule, TelegramModule]);
    h = createBotHarness(ctx.get(StaffBot), ctx.get(ActorResolver));
    teacherId = (
      await createAccount(tdb.txm, {
        telegramUserId: tg,
        roles: ['TEACHER'],
        firstName: 'Анна',
        timezone: 'Europe/Minsk',
      })
    ).id;
    await ctx
      .get(TeacherProfileRepository)
      .upsert(teacherId, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now() });
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('adds a weekday rule, closes a day, toggles the calendar mode, removes a rule', async () => {
    await h.text(teacher(), '/menu');
    await h.press(teacher(), '⚙️ Настройки');
    await h.press(teacher(), '🗓 Окна и календарь');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('окон нет');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('закрыт для записи');

    await h.press(teacher(), '➕ Окно по дням');
    await h.press(teacher(), 'Далее'); // nothing chosen yet
    const answer = h.tg.calls.filter((c) => c.method === 'answerCallbackQuery').at(-1);
    expect(answer?.payload['text']).toContain('хотя бы один');
    await h.press(teacher(), 'Пн–Пт');
    await h.press(teacher(), '✅ пт'); // drop Friday
    expect(h.tg.sentTexts(tg).at(-1)).toContain('выбрано: 4');
    await h.press(teacher(), 'Далее');
    await h.text(teacher(), '15:00');
    await h.text(teacher(), '14:00');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('позже начала');
    await h.text(teacher(), '20:00');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Окно добавлено');
    await h.press(teacher(), '◀️ Назад');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('• пн 15:00–20:00');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('• чт 15:00–20:00');
    expect(h.tg.sentTexts(tg).at(-1)).not.toContain('• пт');

    await h.press(teacher(), '🚫 Закрыть день');
    await h.press(teacher(), 'Завтра');
    await h.press(teacher(), 'Весь день');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('вт 20.10: время закрыто');
    await h.press(teacher(), '◀️ Назад');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('🚫 вт 20.10');

    await h.press(teacher(), '📅 Календарь: закрыт');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('открыт для всех учеников');
    expect((await ctx.get(TeacherProfileRepository).find(teacherId))?.calendarMode).toBe('open_all');

    await h.press(teacher(), '🗑 пн 15:00–20:00');
    expect(h.tg.sentTexts(tg).at(-1)).not.toContain('• пн');
    expect(await ctx.get(AvailabilityRepository).listRules(teacherId)).toHaveLength(3);
  });
});
