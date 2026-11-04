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
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { notification } from '@modules/notifications/schema.js';
import { GroupsUseCase } from '@modules/people/groups/groups.use-case.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { AvailabilityRepository } from '@modules/schedule/availability/availability.repository.js';
import { CreateLessonUseCase } from '@modules/schedule/lessons/create-lesson.use-case.js';
import { LessonRepository } from '@modules/schedule/lessons/lesson.repository.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { BotApiModule } from '@telegram/api/bot-api.module.js';
import { TelegramModule } from '../../telegram.module.js';
import { StaffBot } from '../staff-bot.js';

describe('UC-22: bulk cancellation in StaffBot (M4-02)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let h: BotHarness;
  let teacher: Actor;
  let petyaId: string;
  let mashaId: string;
  let groupId: string;
  const tg = nextTelegramUserId();
  const anna = () => ({ id: tg, first_name: 'Анна' });
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
      defaultNoticeText: 'Заболела, занятия отменяются',
      lateCancelHours: 24,
    });
    petyaId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Петя', lastName: 'Иванов' }))
      .id;
    mashaId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Маша', lastName: 'Петрова' }))
      .id;
    await linkStudent(ctx, t.id, petyaId, { maxLessonsPerWeek: null });
    await linkStudent(ctx, t.id, mashaId, { maxLessonsPerWeek: null });
    const groups = ctx.get(GroupsUseCase);
    groupId = (await groups.create(teacher, { name: '10А', subjectId: MATH_ID })).id;
    await groups.addMember(teacher, groupId, petyaId);
    await groups.addMember(teacher, groupId, mashaId);
    const create = ctx.get(CreateLessonUseCase);
    // Monday 2026-10-19 12:00Z: lessons on Tue, Wed (group), Thu and the week after
    for (const [iso, target] of [
      ['2026-10-20T09:00:00Z', { studentId: petyaId }], // 21 h ahead → late
      ['2026-10-21T13:00:00Z', { groupId }],
      ['2026-10-22T13:00:00Z', { studentId: mashaId }],
      ['2026-10-29T13:00:00Z', { studentId: petyaId }],
    ] as const) {
      await create.execute(teacher, { target, startsAt: new Date(iso), durationMin: 60 });
    }
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('period «7 дней» → preview with the late mark → close the windows → default text → confirm → one summary per student', async () => {
    await h.text(anna(), '/menu');
    await h.press(anna(), '📅 Сегодня / Неделя');
    await h.press(anna(), '❌ Отменить несколько');
    expect(last()).toContain('Что отменяем?');
    await h.press(anna(), '📆 За период');
    await h.press(anna(), '7 дней');
    const preview = last();
    expect(preview).toContain('3 занятия, поздних: 1');
    expect(preview).toContain('⚠️ вт 20.10 12:00 Петя Иванов');
    expect(preview).toContain('ср 21.10 16:00 10А');
    expect(preview).not.toContain('29.10');
    await h.press(anna(), '⬜ Закрыть окна на период');
    expect(h.tg.findButton('☑️ Закрыть окна на период', tg)).toBeDefined();
    await h.press(anna(), 'Далее ➡️');
    expect(last()).toContain('Причина для всего пакета');
    await h.press(anna(), '✉️ Отправить текст по умолчанию');
    expect(last()).toContain('Отменить 3 занятия?');
    expect(last()).toContain('Окна на этот период будут закрыты');
    await h.press(anna(), '✅ Отменить (3)');
    expect(last()).toContain('Отменено: 3');
    expect(last()).toContain('Закрыто дней: 7');
    const week = await ctx.get(LessonRepository).listByTeacher(teacher.accountId, {
      start: new Date('2026-10-19T00:00:00Z'),
      end: new Date('2026-10-26T00:00:00Z'),
    });
    expect(week.every((l) => l.status === 'cancelled')).toBe(true);
    const closed = await ctx
      .get(AvailabilityRepository)
      .listExceptions(teacher.accountId, '2026-10-19', '2026-10-25');
    expect(closed).toHaveLength(7);
    await drainOutbox(ctx, tdb);
    const petya = await tdb.db
      .select()
      .from(notification)
      .where(and(eq(notification.recipientId, petyaId), eq(notification.typeCode, 'cancellation.bulk')));
    expect(petya).toHaveLength(1);
    expect(petya[0]!.payload).toMatchObject({ cancelledCount: 2, message: 'Заболела, занятия отменяются' });
  });

  it('«Выбрать из списка»: toggles, own text, confirm; the student-or-group mode asks for the period', async () => {
    await h.callback(anna(), 's:today:bulk');
    await h.press(anna(), '☑️ Выбрать из списка');
    expect(last()).toContain('Отметьте занятия');
    await h.press(anna(), /⬜ чт 29.10 16:00 Петя Иванов/);
    expect(h.tg.findButton(/☑️ чт 29.10 16:00/, tg)).toBeDefined();
    await h.press(anna(), 'Далее ➡️');
    expect(last()).toContain('1 занятие');
    expect(h.tg.findButton(/Закрыть окна/, tg)).toBeUndefined(); // no period → no windows to close
    await h.press(anna(), 'Далее ➡️');
    await h.press(anna(), '✍️ Свой текст');
    await h.text(anna(), 'Семинар');
    await h.press(anna(), '✅ Отменить (1)');
    expect(last()).toContain('Отменено: 1');
    await h.callback(anna(), 's:today:bulk');
    await h.press(anna(), '👤 Ученик или группа за период');
    expect(last()).toContain('С кем?');
    await h.press(anna(), /Маша Петрова/);
    expect(last()).toContain('За какой период?');
    await h.press(anna(), 'Ввести даты');
    await h.text(anna(), 'вчера');
    expect(last()).toContain('Не понял даты');
    await h.text(anna(), '19.10-30.10');
    expect(last()).toContain('отменять нечего'); // Masha's only lesson is already cancelled
  });
});
