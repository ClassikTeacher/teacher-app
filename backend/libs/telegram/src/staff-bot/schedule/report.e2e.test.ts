import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
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
import { CreateLessonUseCase } from '@modules/schedule/lessons/create-lesson.use-case.js';
import { LessonLifecycleJob } from '@modules/schedule/lessons/lesson-lifecycle.job.js';
import { LessonRepository } from '@modules/schedule/lessons/lesson.repository.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { BotApiModule } from '@telegram/api/bot-api.module.js';
import { TelegramModule } from '../../telegram.module.js';
import { StaffBot } from '../staff-bot.js';

describe('UC-24 in StaffBot: the report from the notification buttons and «Требует внимания»', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let h: BotHarness;
  let teacherId: string;
  let petyaId: string;
  const tg = nextTelegramUserId();
  const teacher = () => ({ id: tg, first_name: 'Анна' });
  const asTeacher = (): Actor => ({
    accountId: teacherId,
    roles: ['TEACHER'],
    status: 'active',
    source: 'bot',
  });

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
    petyaId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Петя', lastName: 'Иванов' }))
      .id;
    await linkStudent(ctx, teacherId, petyaId);
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('«Тема как планировали» → attendance → comment → saved; «Позже» leaves it in «Требует внимания»; no-show', async () => {
    const create = ctx.get(CreateLessonUseCase);
    const first = (
      await create.execute(asTeacher(), {
        target: { studentId: petyaId },
        startsAt: new Date('2026-10-19T13:00:00Z'),
        durationMin: 60,
        plannedTopic: 'Дроби',
      })
    ).lesson;
    const second = (
      await create.execute(asTeacher(), {
        target: { studentId: petyaId },
        startsAt: new Date('2026-10-19T15:00:00Z'),
        durationMin: 60,
      })
    ).lesson;
    ctx.clock.set('2026-10-19T16:30:00Z');
    await ctx.get(LessonLifecycleJob).run();
    await drainOutbox(ctx, tdb);
    const asks = await tdb.db
      .select()
      .from(notification)
      .where(eq(notification.typeCode, 'lesson.report_required'));
    expect(asks.length).toBe(4);

    // the notification's "Позже" button
    await h.text(teacher(), '/menu');
    await h.callback(teacher(), `s:today:rep:${first.id}:later`);
    expect(h.tg.sentTexts(tg).at(-1)).toContain('напомню позже');
    await h.text(teacher(), '/menu');
    await h.press(teacher(), '⚠️ Требует внимания');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('занятия без итогов');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('📝 16:00–17:00 Петя Иванов');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('📝 18:00–19:00 Петя Иванов');

    // the notification's "Тема как планировали" button: straight to attendance
    await h.callback(teacher(), `s:today:rep:${first.id}:planned`);
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Посещаемость');
    await h.press(teacher(), '⏱ Опоздал(а)');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Комментарий ученику');
    await h.text(teacher(), 'Отлично поработали');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Итоги сохранены');
    const repo = ctx.get(LessonRepository);
    expect((await repo.findById(first.id))!).toMatchObject({
      status: 'completed',
      topic: 'Дроби',
      sharedComment: 'Отлично поработали',
    });
    await h.callback(teacher(), `s:today:rep:${first.id}:topic`); // a stale button on the old notification
    expect(h.tg.sentTexts(tg).at(-2)).toContain('Итоги уже заполнены'); // then the card is shown

    // the second lesson: from the card, typed topic is replaced by "Ученик не пришёл"
    await h.text(teacher(), '/menu');
    await h.press(teacher(), '⚠️ Требует внимания');
    expect(h.tg.sentTexts(tg).at(-1)).not.toContain('16:00–17:00');
    await h.press(teacher(), /18:00 Петя Иванов/);
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Какая была тема?');
    await h.press(teacher(), '🚫 Ученик не пришёл');
    await h.press(teacher(), 'Неявка');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('не состоялось');
    expect((await repo.findById(second.id))!).toMatchObject({ status: 'not_held', notHeldReason: 'Неявка' });
    await h.text(teacher(), '/menu');
    await h.press(teacher(), '⚠️ Требует внимания');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Всё заполнено');
    // a report button for another teacher's lesson falls back to the list
    const other = await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Олег' });
    await ctx
      .get(TeacherProfileRepository)
      .upsert(other.id, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now() });
    const stranger = await createAccount(tdb.txm, { roles: ['STUDENT'] });
    await linkStudent(ctx, other.id, stranger.id);
    const foreign = await create.execute(
      { ...asTeacher(), accountId: other.id },
      { target: { studentId: stranger.id }, startsAt: new Date('2026-10-19T17:00:00Z'), durationMin: 30 },
    );
    await h.callback(teacher(), `s:today:rep:${foreign.lesson.id}:topic`);
    expect(h.tg.sentTexts(tg).at(-1)).not.toContain('Какая была тема?');

    await drainOutbox(ctx, tdb);
    const summaries = await tdb.db
      .select()
      .from(notification)
      .where(eq(notification.typeCode, 'lesson.summary'));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.payload).toMatchObject({ attendance: 'late', comment: 'Отлично поработали' });
    const reminders = await tdb.db
      .select()
      .from(notification)
      .where(eq(notification.dedupeKey, `lesson.report_reminder:${second.id}`));
    expect(reminders[0]!.status).toBe('cancelled');
  });
});
