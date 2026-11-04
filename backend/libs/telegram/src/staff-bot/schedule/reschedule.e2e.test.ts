import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '@test/app.js';
import { createBotHarness, type BotHarness } from '@test/bot.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount, nextTelegramUserId } from '@test/factories.js';
import { drainOutbox } from '@test/outbox.js';
import { linkStudent, MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import type { Actor } from '@modules/access/actor.js';
import { FeatureAdminUseCase } from '@modules/access/features/feature-admin.use-case.js';
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { notification } from '@modules/notifications/schema.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { AvailabilityUseCase } from '@modules/schedule/availability/availability.use-case.js';
import { CreateLessonUseCase } from '@modules/schedule/lessons/create-lesson.use-case.js';
import { LessonRepository } from '@modules/schedule/lessons/lesson.repository.js';
import { RescheduleRequestUseCase } from '@modules/schedule/reschedule/reschedule-request.use-case.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { BotApiModule } from '@telegram/api/bot-api.module.js';
import { TelegramModule } from '../../telegram.module.js';
import { StaffBot } from '../staff-bot.js';

describe('UC-18 and request decisions in StaffBot (M4-03)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let h: BotHarness;
  let teacher: Actor;
  let petyaId: string;
  const tg = nextTelegramUserId();
  const anna = () => ({ id: tg, first_name: 'Анна' });
  const last = () => h.tg.sentTexts(tg).at(-1)!;
  const lessons = () => ctx.get(LessonRepository);
  const lessonAt = (iso: string) =>
    ctx
      .get(CreateLessonUseCase)
      .execute(teacher, { target: { studentId: petyaId }, startsAt: new Date(iso), durationMin: 60 });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [
      PeopleModule,
      AccessModule,
      ScheduleModule,
      BotApiModule,
      NotificationsModule,
      TelegramModule,
    ]);
    h = createBotHarness(ctx.get(StaffBot), ctx.get(ActorResolver));
    const t = await createAccount(tdb.txm, {
      telegramUserId: tg,
      roles: ['TEACHER'],
      firstName: 'Анна',
      timezone: 'Europe/Minsk',
    });
    teacher = { accountId: t.id, roles: ['TEACHER'], status: 'active', source: 'bot' };
    await ctx.get(TeacherProfileRepository).upsert(t.id, {
      subjectIds: [MATH_ID],
      onboardedAt: ctx.clock.now(),
      defaultNoticeText: 'Вынуждена перенести',
      calendarMode: 'open_all',
    });
    petyaId = (
      await createAccount(tdb.txm, {
        roles: ['STUDENT'],
        firstName: 'Петя',
        lastName: 'Иванов',
        timezone: 'Europe/Minsk',
      })
    ).id;
    await linkStudent(ctx, t.id, petyaId, { maxLessonsPerWeek: null });
    const admin = await createAccount(tdb.txm, { roles: ['ADMIN'] });
    await ctx
      .get(FeatureAdminUseCase)
      .setTeacher(
        { accountId: admin.id, roles: ['ADMIN'], status: 'active', source: 'bot' },
        t.id,
        'calendar.open_booking',
        { enabled: true },
      );
    await ctx
      .get(AvailabilityUseCase)
      .addRule(teacher, { weekdays: [1, 2, 3, 4, 5, 6, 7], startMin: 600, endMin: 1080 });
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('card → «Перенести» → day → slot → no comment → confirm; the student gets the notice with the default text', async () => {
    const { lesson } = await lessonAt('2026-10-20T13:00:00Z');
    await h.callback(anna(), `s:today:lesson:${lesson.id}`);
    expect(h.tg.findButton('🔁 Перенести', tg)).toBeDefined();
    await h.press(anna(), '🔁 Перенести');
    expect(last()).toContain('Перенос занятия');
    await h.press(anna(), 'Завтра');
    expect(last()).toContain('новое время');
    expect(h.tg.findButton('10:00', tg)).toBeDefined(); // free slots offered; a later time is typed
    await h.text(anna(), '18:00');
    expect(last()).toContain('Комментарий для участников');
    await h.press(anna(), 'Без комментария (текст по умолчанию)');
    expect(last()).toContain('Перенести занятие?');
    expect(last()).toContain('Сообщение: <i>Вынуждена перенести</i>');
    await h.press(anna(), '✅ Перенести');
    expect(last()).toContain('Занятие перенесено на вт 20.10 18:00');
    const moved = (await lessons().findById(lesson.id))!;
    expect(moved.startsAt).toEqual(new Date('2026-10-20T15:00:00Z'));
    expect(moved.version).toBe(2);
    await drainOutbox(ctx, tdb);
    const notes = await tdb.db
      .select()
      .from(notification)
      .where(and(eq(notification.recipientId, petyaId), eq(notification.typeCode, 'lesson.rescheduled')));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.payload).toMatchObject({ to: 'вт 20.10 18:00', comment: 'Вынуждена перенести' });
    // the same time again → explained, the day's slots are re-offered
    await h.callback(anna(), `s:today:move:${lesson.id}`);
    await h.press(anna(), 'Завтра');
    await h.text(anna(), '18:00');
    await h.press(anna(), 'Без комментария (текст по умолчанию)');
    await h.press(anna(), '✅ Перенести');
    expect(h.tg.sentTexts(tg).some((t) => t.includes('Занятие уже стоит на это время'))).toBe(true);
    await h.press(anna(), 'Отмена');
  });

  it('«Заявки»: a request card → accept moves the lesson; a plea → close with a message; stale buttons explained', async () => {
    const { lesson } = await lessonAt('2026-10-26T13:00:00Z');
    const petya: Actor = { accountId: petyaId, roles: ['STUDENT'], status: 'active', source: 'bot' };
    const requests = ctx.get(RescheduleRequestUseCase);
    const row = await requests.request(petya, {
      lessonId: lesson.id,
      startsAt: new Date('2026-10-27T08:00:00Z'),
      reason: 'Олимпиада',
    });
    await h.text(anna(), '/menu');
    await h.press(anna(), '📅 Сегодня / Неделя');
    await h.press(anna(), '📨 Заявки');
    expect(last()).toContain('ожидают ответа: 1');
    expect(last()).toContain('🔁 Петя Иванов: пн 26.10 16:00 → вт 27.10 11:00');
    await h.press(anna(), /Петя Иванов/);
    expect(last()).toContain('Запрос на перенос');
    expect(last()).toContain('Причина: <i>Олимпиада</i>');
    await h.press(anna(), '✅ Подтвердить');
    expect(
      h.tg.sentTexts(tg).some((t) => t.includes('Перенос подтверждён: занятие теперь вт 27.10 11:00')),
    ).toBe(true);
    expect((await lessons().findById(lesson.id))!.startsAt).toEqual(new Date('2026-10-27T08:00:00Z'));
    expect(last()).toContain('Открытых заявок нет');
    const plea = await requests.ask(petya, { lessonId: lesson.id, reason: 'Хочу раньше' });
    await drainOutbox(ctx, tdb);
    await h.callback(anna(), `s:today:rq:${plea.id}:card`);
    expect(last()).toContain('Просьба о переносе');
    await h.press(anna(), 'Закрыть просьбу');
    expect(last()).toContain('Сообщение ученику');
    await h.text(anna(), 'Пока оставим как есть');
    expect(last()).toContain('Заявка отклонена');
    await h.callback(anna(), `s:today:rq:${row.id}:ok`); // already decided
    expect(h.tg.sentTexts(tg).some((t) => t.includes('Заявка уже закрыта'))).toBe(true);
  });
});
