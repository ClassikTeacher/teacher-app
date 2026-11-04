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
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { TeacherSettingsUseCase } from '@modules/people/teacher-settings.use-case.js';
import { CancellationRepository } from '@modules/schedule/cancellations/cancellation.repository.js';
import { CreateLessonUseCase } from '@modules/schedule/lessons/create-lesson.use-case.js';
import { LessonRepository } from '@modules/schedule/lessons/lesson.repository.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { BotApiModule } from '@telegram/api/bot-api.module.js';
import { TelegramModule } from '../../telegram.module.js';
import { StaffBot } from '../staff-bot.js';

describe('UC-20 by the teacher in StaffBot (M4-01, Р-23)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let h: BotHarness;
  let teacher: Actor;
  let petyaId: string;
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
      defaultNoticeText: 'Вынуждена отменить занятие, прошу прощения',
      lateCancelHours: 24,
    });
    await ctx
      .get(TeacherSettingsUseCase)
      .addTemplate(teacher, 'cancel_reason', 'Технические проблемы со связью');
    petyaId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Петя', lastName: 'Иванов' }))
      .id;
    await linkStudent(ctx, t.id, petyaId, { maxLessonsPerWeek: null });
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  const lesson = (startIso: string) =>
    ctx.get(CreateLessonUseCase).execute(teacher, {
      target: { studentId: petyaId },
      startsAt: new Date(startIso),
      durationMin: 60,
    });

  it('card → «Отменить» → the default text is offered first → confirm; the student gets the message', async () => {
    const { lesson: l } = await lesson('2026-10-20T13:00:00Z'); // tomorrow 16:00 Minsk, 25 h ahead
    await h.text(anna(), '/menu');
    await h.press(anna(), '📅 Сегодня / Неделя');
    await h.press(anna(), 'Завтра');
    await h.press(anna(), /16:00 Петя Иванов/);
    expect(h.tg.findButton('❌ Отменить', tg)).toBeDefined();
    await h.press(anna(), '❌ Отменить');
    expect(last()).toContain('Текст по умолчанию: <i>Вынуждена отменить занятие, прошу прощения</i>');
    expect(h.tg.findButton('✉️ Отправить текст по умолчанию', tg)).toBeDefined();
    expect(h.tg.findButton('Технические проблемы со связью', tg)).toBeDefined();
    expect(h.tg.findButton('Заболел(а), занятие отменяется', tg)).toBeUndefined(); // own templates replace the starter set
    await h.press(anna(), '✉️ Отправить текст по умолчанию');
    expect(last()).toContain('Отменить занятие?');
    expect(last()).toContain('Петя Иванов');
    expect(last()).not.toContain('Поздняя отмена');
    await h.press(anna(), '✅ Подтвердить');
    expect(last()).toContain('отменено');
    expect((await ctx.get(LessonRepository).findById(l.id))!.status).toBe('cancelled');
    await drainOutbox(ctx, tdb);
    const toPetya = await tdb.db
      .select()
      .from(notification)
      .where(and(eq(notification.recipientId, petyaId), eq(notification.typeCode, 'lesson.cancelled')));
    expect(toPetya).toHaveLength(1);
    expect(toPetya[0]!.payload).toMatchObject({
      view: 'by-teacher',
      message: 'Вынуждена отменить занятие, прошу прощения',
    });
    await h.press(anna(), '◀️ К занятию');
    expect(last()).toContain('отменено');
    expect(h.tg.findButton('❌ Отменить', tg)).toBeUndefined();
  });

  it('a template is recorded by id with the late mark; a lesson already over cannot be cancelled', async () => {
    ctx.clock.set('2026-10-19T12:00:00Z');
    const { lesson: l } = await lesson('2026-10-19T15:00:00Z'); // 3 h ahead → late
    await h.callback(anna(), `s:today:cancel:${l.id}`);
    await h.press(anna(), 'Технические проблемы со связью');
    expect(last()).toContain('Поздняя отмена: до начала меньше 24 ч');
    await h.press(anna(), '✅ Подтвердить');
    const row = (await ctx.get(LessonRepository).findById(l.id))!;
    expect(row.status).toBe('cancelled');
    const act = (await ctx.get(CancellationRepository).findById(row.cancellationId!))!;
    expect(act.templateId).not.toBeNull();
    const items = await ctx.get(CancellationRepository).listItems(act.id);
    expect(items[0]!.isLate).toBe(true);

    const { lesson: over } = await lesson('2026-10-19T13:00:00Z');
    ctx.clock.set('2026-10-19T14:30:00Z');
    await h.callback(anna(), `s:today:cancel:${over.id}`);
    expect(h.tg.sentTexts(tg).some((t) => t.includes('Занятие уже отменено или завершено'))).toBe(true);
    expect((await ctx.get(LessonRepository).findById(over.id))!.status).toBe('scheduled');
    ctx.clock.set('2026-10-19T12:00:00Z');
  });
});
