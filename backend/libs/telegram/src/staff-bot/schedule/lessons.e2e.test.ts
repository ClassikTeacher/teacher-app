import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '@test/app.js';
import { createBotHarness, type BotHarness } from '@test/bot.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount, nextTelegramUserId } from '@test/factories.js';
import { drainOutbox } from '@test/outbox.js';
import { linkStudent, MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { notification } from '@modules/notifications/schema.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { LessonRepository } from '@modules/schedule/lessons/lesson.repository.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { BotApiModule } from '@telegram/api/bot-api.module.js';
import { TelegramModule } from '../../telegram.module.js';
import { StaffBot } from '../staff-bot.js';

describe('UC-14: quick lesson creation in StaffBot (M3-02)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let h: BotHarness;
  let teacherId: string;
  let petyaId: string;
  const tg = nextTelegramUserId();
  const teacher = () => ({ id: tg, first_name: 'Анна' });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    // fixed clock 2026-10-19 12:00Z (Monday); teacher in Europe/Minsk (+3)
    ctx = await createTestContext(tdb, [
      PeopleModule,
      AccessModule,
      ScheduleModule,
      BotApiModule,
      NotificationsModule,
      TelegramModule,
    ]);
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
      .upsert(teacherId, { subjectIds: [MATH_ID], defaultDurationMin: 60, onboardedAt: ctx.clock.now() });
    petyaId = (
      await createAccount(tdb.txm, {
        roles: ['STUDENT'],
        firstName: 'Петя',
        lastName: 'Иванов',
        timezone: 'Europe/Moscow',
      })
    ).id;
    await linkStudent(ctx, teacherId, petyaId);
    const masha = await createAccount(tdb.txm, {
      roles: ['STUDENT'],
      firstName: 'Маша',
      lastName: 'Петрова',
    });
    await linkStudent(ctx, teacherId, masha.id);
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('student → tomorrow → slot → create; conflict 3а re-offers slots; the card and «Повторить через неделю» work', async () => {
    await h.text(teacher(), '/menu');
    await h.press(teacher(), '➕ Занятие');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('С кем?');
    await h.press(teacher(), 'Петя Иванов');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Петя Иванов: на какой день?');
    await h.press(teacher(), 'Завтра');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('вт 20.10: во сколько?');
    expect(h.tg.findButton('07:00', tg)).toBeDefined(); // slots start at 07:00 local
    await h.press(teacher(), '10:00');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('вт 20.10 10:00: длительность');
    await h.press(teacher(), '✅ Создать · 60 мин');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Занятие создано: Петя Иванов, вт 20.10 10:00–11:00');

    const lessons = await ctx.get(LessonRepository).listByTeacher(teacherId, {
      start: new Date('2026-10-20T00:00:00Z'),
      end: new Date('2026-10-21T00:00:00Z'),
    });
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.startsAt.toISOString()).toBe('2026-10-20T07:00:00.000Z'); // 10:00 Minsk
    expect(lessons[0]!.seqNo).toBe(1);

    // 3а: Masha at the same time → the teacher is busy; the time step comes back without 10:00 among the slots
    await h.text(teacher(), '/menu');
    await h.press(teacher(), '➕ Занятие');
    await h.press(teacher(), 'Маша Петрова');
    await h.text(teacher(), '20.10');
    expect(h.tg.findButton('10:00', tg)).toBeUndefined();
    expect(h.tg.findButton('11:00', tg)).toBeDefined();
    await h.text(teacher(), '10:30');
    await h.press(teacher(), '90 мин');
    expect(h.tg.sentTexts(tg).at(-2)).toContain('У вас в это время занятие');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('во сколько?');
    await h.press(teacher(), '11:00');
    await h.press(teacher(), '✅ Создать · 90 мин'); // the duration chosen before the conflict is kept
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Маша Петрова, вт 20.10 11:00–12:30');

    // the day view lists both, the card opens, "repeat next week" creates 27.10 10:00
    await h.press(teacher(), '◀️ Назад');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('🕓 10:00–11:00 Петя Иванов · Математика');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('🕓 11:00–12:30 Маша Петрова');
    await h.press(teacher(), '🕓 10:00 Петя Иванов');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Занятие №1');
    await h.press(teacher(), '🔁 Повторить через неделю');
    expect(h.tg.sentTexts(tg).at(-2)).toContain('Повторено: Петя Иванов, вт 27.10 10:00');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Занятие №2');
    await h.press(teacher(), '🔁 Повторить через неделю');
    await h.press(teacher(), '🔁 Повторить через неделю'); // same slot twice is refused with a conflict notice
    expect(h.tg.sentTexts(tg).some((t) => t.includes('Занятие №3'))).toBe(true);

    // the student card button starts the dialog with the student preset (day step first)
    await h.text(teacher(), '/menu');
    await h.press(teacher(), '👥 Ученики');
    await h.press(teacher(), 'Петя Иванов');
    await h.press(teacher(), '➕ Поставить занятие');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Шаг 2');
    await h.text(teacher(), '/cancel');

    // the student learns about the lesson in his own zone (Moscow = Minsk) and reminders are planned
    await drainOutbox(ctx, tdb);
    const sent = await tdb.db.select().from(notification).where(eq(notification.recipientId, petyaId));
    const created = sent.filter((n) => n.typeCode === 'lesson.created');
    expect(created.length).toBeGreaterThanOrEqual(3);
    expect(created.map((n) => n.payload['when'])).toContain('вт 20.10 10:00');
    expect(created.every((n) => n.payload['subject'] === 'Математика')).toBe(true);
    expect(
      sent.some(
        (n) => n.typeCode === 'lesson.reminder' && n.dueAt.toISOString() === '2026-10-20T06:00:00.000Z',
      ),
    ).toBe(true);
  });
});
