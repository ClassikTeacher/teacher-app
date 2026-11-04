import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@test/app.js';
import { createBotHarness, type BotHarness } from '@test/bot.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount, nextTelegramUserId } from '@test/factories.js';
import { linkStudent, MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import type { Actor } from '@modules/access/actor.js';
import { FeatureAdminUseCase } from '@modules/access/features/feature-admin.use-case.js';
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { TeacherSettingsUseCase } from '@modules/people/teacher-settings.use-case.js';
import { AvailabilityUseCase } from '@modules/schedule/availability/availability.use-case.js';
import { LessonRepository } from '@modules/schedule/lessons/lesson.repository.js';
import { BookingRequestRepository } from '@modules/schedule/requests/booking-request.repository.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { BotApiModule } from '@telegram/api/bot-api.module.js';
import { TelegramModule } from '../telegram.module.js';
import { StudentBot } from './student-bot.js';

describe('UC-16 in StudentBot (M4-04)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let h: BotHarness;
  let anna: Actor;
  let oleg: Actor;
  let petyaId: string;
  const tg = nextTelegramUserId();
  const petya = () => ({ id: tg, first_name: 'Петя' });
  const last = () => h.tg.sentTexts(tg).at(-1)!;

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
    h = createBotHarness(ctx.get(StudentBot), ctx.get(ActorResolver));
    const profiles = ctx.get(TeacherProfileRepository);
    const a = await createAccount(tdb.txm, {
      roles: ['TEACHER'],
      firstName: 'Анна',
      lastName: 'П',
      timezone: 'Europe/Minsk',
    });
    const o = await createAccount(tdb.txm, {
      roles: ['TEACHER'],
      firstName: 'Олег',
      lastName: 'Б',
      timezone: 'Europe/Minsk',
    });
    anna = { accountId: a.id, roles: ['TEACHER'], status: 'active', source: 'bot' };
    oleg = { accountId: o.id, roles: ['TEACHER'], status: 'active', source: 'bot' };
    await profiles.upsert(a.id, {
      subjectIds: [MATH_ID],
      onboardedAt: ctx.clock.now(),
      calendarMode: 'open_all',
    });
    await profiles.upsert(o.id, {
      subjectIds: [MATH_ID],
      onboardedAt: ctx.clock.now(),
      calendarMode: 'open_all',
      bookingConfirmation: 'manual',
    });
    await ctx.get(TeacherSettingsUseCase).update(oleg, { bookingRules: { durations: [45, 90] } });
    const st = await createAccount(tdb.txm, {
      telegramUserId: tg,
      roles: ['STUDENT'],
      firstName: 'Петя',
      lastName: 'Иванов',
      timezone: 'Europe/Minsk',
    });
    petyaId = st.id;
    await linkStudent(ctx, a.id, st.id, { maxLessonsPerWeek: 1 });
    await linkStudent(ctx, o.id, st.id, { maxLessonsPerWeek: null });
    const admin = {
      accountId: (await createAccount(tdb.txm, { roles: ['ADMIN'] })).id,
      roles: ['ADMIN' as const],
      status: 'active' as const,
      source: 'bot' as const,
    };
    for (const t of [a.id, o.id]) {
      await ctx.get(FeatureAdminUseCase).setTeacher(admin, t, 'calendar.open_booking', { enabled: true });
    }
    await ctx
      .get(AvailabilityUseCase)
      .addRule(anna, { weekdays: [1, 2, 3, 4, 5, 6, 7], startMin: 600, endMin: 1080 });
    await ctx
      .get(AvailabilityUseCase)
      .addRule(oleg, { weekdays: [1, 2, 3, 4, 5, 6, 7], startMin: 600, endMin: 1080 });
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('auto mode: teacher → day → slot → no comment → confirm → the lesson is in the schedule; PPL-06 on the second try', async () => {
    await h.text(petya(), '/menu');
    await h.press(petya(), '➕ Записаться');
    expect(last()).toContain('К кому?');
    await h.press(petya(), 'Анна П');
    expect(last()).toContain('Анна П: на какой день?');
    await h.press(petya(), 'Завтра');
    expect(last()).toContain('открытые слоты (60 мин)');
    await h.press(petya(), '12:00');
    expect(last()).toContain('Комментарий учителю');
    await h.press(petya(), 'Без комментария');
    expect(last()).toContain('Записаться?');
    expect(last()).toContain('<b>вторник 20.10 12:00</b> (60 мин)');
    expect(last()).not.toContain('Учитель подтвердит заявку');
    await h.press(petya(), '✅ Записаться');
    expect(last()).toContain('Готово: занятие <b>вторник 20.10 12:00</b> у Анна П в расписании');
    const rows = await ctx.get(LessonRepository).listByStudent(petyaId, {
      start: new Date('2026-10-20T00:00:00Z'),
      end: new Date('2026-10-21T00:00:00Z'),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      createdVia: 'student_booking',
      startsAt: new Date('2026-10-20T09:00:00Z'),
    });
    // the weekly limit at Anna's is 1 → explained (1б)
    await h.text(petya(), '/menu');
    await h.press(petya(), '➕ Записаться');
    await h.press(petya(), 'Анна П');
    await h.press(petya(), 'Завтра');
    await h.press(petya(), '14:00');
    await h.press(petya(), 'Без комментария');
    await h.press(petya(), '✅ Записаться');
    expect(last()).toContain('На этой неделе у вас уже 1 занятие у этого учителя');
  });

  it('manual mode with several durations: a request is sent; the same slot again → «уже отправили заявку»', async () => {
    await h.text(petya(), '/menu');
    await h.press(petya(), '➕ Записаться');
    await h.press(petya(), 'Олег Б');
    await h.press(petya(), 'Завтра');
    expect(last()).toContain('открытые слоты (45 мин)');
    await h.press(petya(), '10:00');
    expect(last()).toContain('Длительность занятия');
    await h.press(petya(), '90 мин');
    await h.text(petya(), 'Нужна помощь с задачами');
    expect(last()).toContain('(90 мин)');
    expect(last()).toContain('Учитель подтвердит заявку');
    await h.press(petya(), '✅ Записаться');
    expect(last()).toContain('Заявка отправлена');
    const pending = await ctx.get(BookingRequestRepository).listPendingByStudent(petyaId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      kind: 'booking',
      comment: 'Нужна помощь с задачами',
      startsAt: new Date('2026-10-20T07:00:00Z'),
      endsAt: new Date('2026-10-20T08:30:00Z'),
    });
    await h.text(petya(), '/menu');
    await h.press(petya(), '➕ Записаться');
    await h.press(petya(), 'Олег Б');
    await h.press(petya(), 'Завтра');
    await h.press(petya(), '10:00');
    await h.press(petya(), '45 мин');
    await h.press(petya(), 'Без комментария');
    await h.press(petya(), '✅ Записаться');
    expect(h.tg.sentTexts(tg).some((t) => t.includes('уже отправили заявку'))).toBe(true);
  });
});
