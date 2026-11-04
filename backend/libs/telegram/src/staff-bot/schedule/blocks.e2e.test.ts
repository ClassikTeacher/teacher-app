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
import { PersonalBlockRepository } from '@modules/schedule/occupancy/personal-block.repository.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { TelegramModule } from '../../telegram.module.js';
import { StaffBot } from '../staff-bot.js';

describe('M3-01: personal blocks in StaffBot «Сегодня / Неделя»', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let h: BotHarness;
  let teacherId: string;
  const tg = nextTelegramUserId();
  const teacher = () => ({ id: tg, first_name: 'Анна' });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    // 2026-10-19 12:00Z is a Monday; the teacher lives in Europe/Minsk (UTC+3)
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

  it('creates a block for tomorrow by buttons and text, shows it in the day and week views, removes it', async () => {
    await h.text(teacher(), '/menu');
    await h.press(teacher(), '📅 Сегодня / Неделя');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('пн 19.10');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Пока ничего не запланировано');

    await h.press(teacher(), '🚫 Занят');
    await h.press(teacher(), 'Завтра');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('вт 20.10');
    await h.text(teacher(), '25:70');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Не понял время');
    await h.text(teacher(), '14:00');
    await h.text(teacher(), '13:30');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('позже начала');
    await h.press(teacher(), '120 мин');
    await h.text(teacher(), 'врач');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Блок «занят» вт 20.10 14:00–16:00 врач создан');

    const blocks = await ctx.get(PersonalBlockRepository).listInRange(teacherId, {
      start: new Date('2026-10-20T00:00:00Z'),
      end: new Date('2026-10-21T00:00:00Z'),
    });
    expect(blocks).toHaveLength(1);
    // 14:00 Minsk = 11:00Z
    expect(blocks[0]!.startsAt.toISOString()).toBe('2026-10-20T11:00:00.000Z');
    expect(blocks[0]!.endsAt.toISOString()).toBe('2026-10-20T13:00:00.000Z');

    await h.press(teacher(), '◀️ Назад');
    await h.press(teacher(), 'Завтра');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('🚫 14:00–16:00 врач');
    await h.press(teacher(), 'Неделя');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Неделя пн 19.10 – вс 25.10');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('🚫 14:00–16:00 врач');

    // an overlapping block is refused with a clear message and the dialog returns to the start time
    await h.press(teacher(), '🚫 Занят');
    await h.text(teacher(), '20.10');
    await h.text(teacher(), '15:00');
    await h.text(teacher(), '17:00');
    await h.press(teacher(), 'Пропустить');
    expect(h.tg.sentTexts(tg).at(-2)).toContain('уже есть занятие или блок');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Шаг 2');
    await h.text(teacher(), '16:00');
    await h.text(teacher(), '17:00');
    await h.press(teacher(), 'Пропустить');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('16:00–17:00');

    // a duration button never crosses midnight: 22:00 + 240 min is capped at 24:00
    await h.press(teacher(), '◀️ Назад');
    await h.press(teacher(), '🚫 Занят');
    await h.text(teacher(), '21.10');
    await h.text(teacher(), '22:00');
    await h.press(teacher(), '240 мин');
    await h.press(teacher(), 'Пропустить');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('22:00–24:00');

    await h.press(teacher(), '◀️ Назад');
    await h.press(teacher(), 'Завтра');
    const stale = h.tg.findButton('🗑 Снять блок 14:00–16:00', tg)!.callback_data!;
    await h.press(teacher(), '🗑 Снять блок 14:00–16:00');
    expect(h.tg.sentTexts(tg).at(-1)).not.toContain('14:00–16:00');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('16:00–17:00');
    await h.callback(teacher(), stale);
    const answer = h.tg.calls.filter((c) => c.method === 'answerCallbackQuery').at(-1);
    expect(answer?.payload['text']).toContain('устарела');
  });
});
