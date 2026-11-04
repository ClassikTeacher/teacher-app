import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '@test/app.js';
import { createBotHarness, type BotHarness } from '@test/bot.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount, nextTelegramUserId } from '@test/factories.js';
import { linkStudent, MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { lesson as lessonTable, lessonSeries } from '@modules/schedule/schema.js';
import { TelegramModule } from '../../telegram.module.js';
import { StaffBot } from '../staff-bot.js';

describe('UC-15 in StaffBot: «Сделать регулярным», series list, pause and end', () => {
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
    const petya = await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Петя', lastName: 'Иванов' });
    await linkStudent(ctx, teacherId, petya.id);
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('turns a lesson into a Mon+Wed series, shows it, pauses and ends it', async () => {
    await h.text(teacher(), '/menu');
    await h.press(teacher(), '➕ Занятие');
    await h.press(teacher(), 'Петя Иванов');
    await h.press(teacher(), 'Завтра'); // Tue 20.10
    await h.text(teacher(), '16:00');
    await h.press(teacher(), '✅ Создать · 60 мин');
    await h.press(teacher(), '📄 Карточка занятия');
    await h.press(teacher(), '🔁 Сделать регулярным');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Петя Иванов, 16:00, 60 мин');
    expect(h.tg.findButton('✅ вт', tg)).toBeDefined(); // the lesson's weekday is preselected
    await h.press(teacher(), 'чт');
    await h.press(teacher(), 'Далее');
    await h.text(teacher(), 'вчера');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Не понял дату');
    await h.press(teacher(), 'Без конца');
    // Tue 20.10 itself collides with the one-off lesson the series was made from: reported, the rest created
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Серия создана: Петя Иванов. Занятий поставлено: 23');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('время занято): вт 20.10 16:00');
    const rows = await tdb.db.select().from(lessonSeries).where(eq(lessonSeries.teacherId, teacherId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rrule).toBe('FREQ=WEEKLY;BYDAY=TU,TH');

    await h.press(teacher(), '📆 К серии');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Дни: вт, чт · 16:00 · 60 мин');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Запланировано занятий: 23');
    await h.press(teacher(), '⏸ Пауза');
    await h.text(teacher(), '02.11');
    await h.text(teacher(), '08.11');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Пауза с пн 02.11 по вс 08.11');
    await h.press(teacher(), '◀️ Назад');
    expect(h.tg.findButton('▶️ Снять паузу', tg)).toBeDefined();
    await h.press(teacher(), '⏹ Завершить серию');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Завершить серию Петя Иванов?');
    await h.press(teacher(), 'Да, завершить');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Регулярных занятий пока нет');
    const ended = await tdb.db.select().from(lessonSeries).where(eq(lessonSeries.teacherId, teacherId));
    expect(ended[0]!.status).toBe('ended');
    // the pause cancelled 3.11 and 5.11, the end cancelled everything else in the future (T-18)
    const instances = await tdb.db.select().from(lessonTable).where(eq(lessonTable.seriesId, rows[0]!.id));
    expect(instances.filter((l) => l.status === 'cancelled').length).toBe(23);
  });
});
