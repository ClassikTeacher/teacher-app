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
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { AvailabilityUseCase } from '@modules/schedule/availability/availability.use-case.js';
import { CreateLessonUseCase } from '@modules/schedule/lessons/create-lesson.use-case.js';
import { BookingRequestRepository } from '@modules/schedule/requests/booking-request.repository.js';
import { RescheduleLessonUseCase } from '@modules/schedule/reschedule/reschedule-lesson.use-case.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { BotApiModule } from '@telegram/api/bot-api.module.js';
import { ParentBot } from '../parent-bot/parent-bot.js';
import { TelegramModule } from '../telegram.module.js';
import { StudentBot } from './student-bot.js';

describe('UC-19 in StudentBot and ParentBot (M4-03)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let student: BotHarness;
  let parent: BotHarness;
  let teacher: Actor;
  let petyaId: string;
  const stTg = nextTelegramUserId();
  const paTg = nextTelegramUserId();
  const petya = () => ({ id: stTg, first_name: 'Петя' });
  const mama = () => ({ id: paTg, first_name: 'Мария' });
  const last = (h: BotHarness, id: number) => h.tg.sentTexts(id).at(-1)!;
  const notes = (recipientId: string, type: string) =>
    tdb.db
      .select()
      .from(notification)
      .where(and(eq(notification.recipientId, recipientId), eq(notification.typeCode, type)));
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
    student = createBotHarness(ctx.get(StudentBot), ctx.get(ActorResolver));
    parent = createBotHarness(ctx.get(ParentBot), ctx.get(ActorResolver));
    const t = await createAccount(tdb.txm, {
      roles: ['TEACHER'],
      firstName: 'Анна',
      lastName: 'П',
      timezone: 'Europe/Minsk',
    });
    teacher = { accountId: t.id, roles: ['TEACHER'], status: 'active', source: 'bot' };
    await ctx
      .get(TeacherProfileRepository)
      .upsert(t.id, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now(), calendarMode: 'open_all' });
    const st = await createAccount(tdb.txm, {
      telegramUserId: stTg,
      roles: ['STUDENT'],
      firstName: 'Петя',
      lastName: 'Иванов',
      timezone: 'Europe/Minsk',
    });
    petyaId = st.id;
    const pa = await createAccount(tdb.txm, {
      telegramUserId: paTg,
      roles: ['PARENT'],
      firstName: 'Мария',
      lastName: 'Иванова',
      timezone: 'Europe/Minsk',
    });
    await ctx.get(FamilyLinkRepository).insert({
      parentId: pa.id,
      studentId: st.id,
      invitedBy: t.id,
      invitationId: null,
      confirmedAt: ctx.clock.now(),
    });
    await linkStudent(ctx, t.id, st.id, { maxLessonsPerWeek: null });
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

  it('open calendar: card → «Перенести» → day → open slot → reason → send; a second request is refused', async () => {
    const { lesson } = await lessonAt('2026-10-26T13:00:00Z');
    await student.callback(petya(), `s:schedule:lesson:${lesson.id}`);
    expect(student.tg.findButton('🔁 Перенести', stTg)).toBeDefined();
    await student.press(petya(), '🔁 Перенести');
    expect(last(student, stTg)).toContain('Запрос на перенос');
    expect(last(student, stTg)).toContain('Учитель подтвердит перенос');
    await student.press(petya(), 'Завтра');
    expect(last(student, stTg)).toContain('выберите открытый слот');
    await student.press(petya(), '11:00');
    expect(last(student, stTg)).toContain('Причина переноса');
    await student.text(petya(), 'Олимпиада');
    expect(last(student, stTg)).toContain('Отправить запрос?');
    expect(last(student, stTg)).toContain('<b>вторник 20.10 11:00</b>');
    await student.press(petya(), '📨 Отправить');
    expect(last(student, stTg)).toContain('Запрос отправлен');
    const pending = await ctx.get(BookingRequestRepository).listPendingByStudent(petyaId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      kind: 'reschedule',
      startsAt: new Date('2026-10-20T08:00:00Z'),
      comment: 'Олимпиада',
    });
    await drainOutbox(ctx, tdb);
    expect(await notes(teacher.accountId, 'booking.requested')).toHaveLength(1);
    await student.callback(petya(), `s:schedule:move:${lesson.id}`);
    await student.press(petya(), 'Завтра');
    await student.press(petya(), '11:30');
    await student.text(petya(), 'Ещё раз');
    await student.press(petya(), '📨 Отправить');
    expect(last(student, stTg)).toContain('уже есть запрос');
  });

  it('closed calendar: a plea with a reason; «Не могу» on a move notice; the parent asks for the child', async () => {
    await ctx.get(TeacherProfileRepository).upsert(teacher.accountId, { calendarMode: 'closed' });
    const { lesson } = await lessonAt('2026-10-28T13:00:00Z');
    await student.callback(petya(), `s:schedule:move:${lesson.id}`);
    expect(last(student, stTg)).toContain('Просьба о переносе');
    await student.text(petya(), 'Не успеваю после школы');
    expect(last(student, stTg)).toContain('Просьба отправлена учителю');
    await drainOutbox(ctx, tdb);
    expect(
      (await notes(teacher.accountId, 'booking.requested')).some(
        (n) => n.payload['view'] === 'reschedule_ask',
      ),
    ).toBe(true);
    // the teacher moves it; the move notice carries «ОК / Не могу»; the student objects with a reason
    await ctx
      .get(RescheduleLessonUseCase)
      .execute(teacher, { lessonId: lesson.id, startsAt: new Date('2026-10-28T15:00:00Z') });
    await drainOutbox(ctx, tdb);
    const notice = (await notes(petyaId, 'lesson.rescheduled')).find((n) => n.dedupeKey.includes(lesson.id))!;
    const buttons = notice.payload['buttons'] as Array<{ text: string; data: string }>;
    await student.callback(petya(), buttons[1]!.data);
    expect(last(student, stTg)).toContain('Почему не подходит новое время');
    await student.text(petya(), 'В это время секция');
    expect(last(student, stTg)).toContain('Учитель получит ваше сообщение');
    await student.callback(petya(), buttons[0]!.data);
    expect(last(student, stTg)).toContain('до встречи на занятии');
    await drainOutbox(ctx, tdb);
    expect((await notes(teacher.accountId, 'lesson.reschedule_objection'))[0]!.payload).toMatchObject({
      reason: 'В это время секция',
    });
    // the parent, from the child's card
    await parent.text(mama(), '/menu');
    await parent.press(mama(), '📅 Расписание ребёнка');
    await parent.press(mama(), /ср 28.10 18:00/);
    await parent.press(mama(), '🔁 Перенести');
    expect(last(parent, paTg)).toContain('Просьба о переносе');
    await parent.text(mama(), 'Едем к врачу');
    expect(last(parent, paTg)).toContain('Просьба отправлена учителю');
    const pleas = (await ctx.get(BookingRequestRepository).listPendingByStudent(petyaId)).filter(
      (r) => r.lessonId === lesson.id,
    );
    expect(pleas).toHaveLength(1);
    expect(pleas[0]!.comment).toBe('Едем к врачу'); // the earlier plea was closed by the move
    await ctx.get(TeacherProfileRepository).upsert(teacher.accountId, { calendarMode: 'open_all' });
  });
});
