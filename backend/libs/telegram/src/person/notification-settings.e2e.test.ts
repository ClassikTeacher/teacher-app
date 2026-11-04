import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@test/app.js';
import { createBotHarness, type BotHarness } from '@test/bot.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount, nextTelegramUserId } from '@test/factories.js';
import { linkStudent, MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { NotificationPrefsRepository } from '@modules/notifications/notification-prefs.repository.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { BotApiModule } from '@telegram/api/bot-api.module.js';
import { ParentBot } from '../parent-bot/parent-bot.js';
import { StaffBot } from '../staff-bot/staff-bot.js';
import { StudentBot } from '../student-bot/student-bot.js';
import { TelegramModule } from '../telegram.module.js';

describe('M4-05: notification settings in the three bots and the student card', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let staff: BotHarness;
  let student: BotHarness;
  let parent: BotHarness;
  let teacherId: string;
  let petyaId: string;
  let linkId: string;
  const tTg = nextTelegramUserId();
  const sTg = nextTelegramUserId();
  const pTg = nextTelegramUserId();
  const anna = () => ({ id: tTg, first_name: 'Анна' });
  const petya = () => ({ id: sTg, first_name: 'Петя' });
  const mama = () => ({ id: pTg, first_name: 'Мария' });
  const last = (h: BotHarness, id: number) => h.tg.sentTexts(id).at(-1)!;

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
    staff = createBotHarness(ctx.get(StaffBot), ctx.get(ActorResolver));
    student = createBotHarness(ctx.get(StudentBot), ctx.get(ActorResolver));
    parent = createBotHarness(ctx.get(ParentBot), ctx.get(ActorResolver));
    teacherId = (
      await createAccount(tdb.txm, {
        telegramUserId: tTg,
        roles: ['TEACHER'],
        firstName: 'Анна',
        timezone: 'Europe/Minsk',
      })
    ).id;
    await ctx
      .get(TeacherProfileRepository)
      .upsert(teacherId, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now() });
    petyaId = (
      await createAccount(tdb.txm, {
        telegramUserId: sTg,
        roles: ['STUDENT'],
        firstName: 'Петя',
        lastName: 'Иванов',
      })
    ).id;
    const pa = await createAccount(tdb.txm, { telegramUserId: pTg, roles: ['PARENT'], firstName: 'Мария' });
    await ctx.get(FamilyLinkRepository).insert({
      parentId: pa.id,
      studentId: petyaId,
      invitedBy: teacherId,
      invitationId: null,
      confirmedAt: ctx.clock.now(),
    });
    linkId = (await linkStudent(ctx, teacherId, petyaId)).id;
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('StaffBot: reminders, quiet hours, digest time, copy defaults, via-parent; the card overrides copies per student', async () => {
    await staff.text(anna(), '/menu');
    await staff.press(anna(), '⚙️ Настройки');
    await staff.press(anna(), '🔔 Уведомления');
    expect(last(staff, tTg)).toContain('Напоминания о занятиях: за 24 ч, за 1 ч');
    expect(last(staff, tTg)).toContain('Тихие часы: 22:00–08:00');
    expect(last(staff, tTg)).toContain('Утренняя сводка: в 08:00');
    expect(last(staff, tTg)).toContain(
      'Копии родителям по умолчанию: Отмена занятия, Перенос занятия, Массовая отмена, Итоги занятия, Новое задание, Просрочка задания, Проверка задания, Завершение занятий',
    );
    await staff.press(anna(), '⏰ Напоминания');
    await staff.press(anna(), '☑️ за 24 ч');
    await staff.press(anna(), '⬜ за 15 мин');
    expect(staff.tg.findButton('☑️ за 15 мин', tTg)).toBeDefined();
    await staff.press(anna(), '◀️ Назад');
    expect(last(staff, tTg)).toContain('Напоминания о занятиях: за 1 ч, за 15 мин');
    await staff.press(anna(), '🌙 Тихие часы');
    await staff.press(anna(), 'Изменить интервал');
    await staff.text(anna(), '23:00-07:00');
    expect(last(staff, tTg)).toContain('Сохранено');
    await staff.press(anna(), '◀️ Назад');
    expect(last(staff, tTg)).toContain('Тихие часы: 23:00–07:00');
    await staff.press(anna(), '☀️ Сводка');
    await staff.press(anna(), 'Время сводки');
    await staff.text(anna(), '7:45');
    await staff.press(anna(), '◀️ Назад');
    expect(last(staff, tTg)).toContain('Утренняя сводка: в 07:45');
    await staff.press(anna(), '📨 Копии родителям');
    await staff.press(anna(), '☑️ Итоги занятия');
    expect(staff.tg.findButton('⬜ Итоги занятия', tTg)).toBeDefined();
    await staff.press(anna(), '◀️ Назад');
    await staff.press(anna(), '⬜ Через родителя');
    expect(last(staff, tTg)).toContain('если ученик заблокировал бота: включена');
    const profile = await ctx.get(NotificationPrefsRepository).profile(teacherId);
    expect(profile).toMatchObject({
      reminderOffsetsMin: [60, 15],
      quietFrom: '23:00:00',
      quietTo: '07:00:00',
      digestTime: '07:45:00',
      deliverViaParent: true,
    });
    // the student card: a per-student override and a reset
    await staff.callback(anna(), `s:students:cc:${linkId}`);
    expect(last(staff, tTg)).toContain('Копии родителям: Петя Иванов');
    expect(staff.tg.findButton('⬜ Итоги занятия', tTg)).toBeDefined();
    await staff.press(anna(), '⬜ Итоги занятия');
    expect(staff.tg.findButton('☑️ Итоги занятия *', tTg)).toBeDefined();
    await staff.press(anna(), '↩️ Сбросить к умолчаниям');
    expect(staff.tg.findButton('⬜ Итоги занятия', tTg)).toBeDefined();
  });

  it('StudentBot and ParentBot: reminders, quiet hours and mutes (critical ones are not offered)', async () => {
    await student.text(petya(), '/menu');
    await student.press(petya(), '⚙️ Настройки');
    expect(last(student, sTg)).toContain('Напоминания о занятиях: за 24 ч, за 1 ч');
    await student.press(petya(), '🔕 Отключить сообщения');
    expect(student.tg.findButton('☑️ Напоминание о занятии', sTg)).toBeDefined();
    expect(student.tg.findButton(/Отмена занятия/, sTg)).toBeUndefined(); // cannot be muted by the recipient
    await student.press(petya(), '☑️ Итоги занятия');
    await student.press(petya(), '◀️ Назад');
    expect(last(student, sTg)).toContain('Отключённые сообщения: Итоги занятия');
    await parent.text(mama(), '/menu');
    await parent.press(mama(), '⚙️ Настройки');
    expect(parent.tg.findButton('⏰ Напоминания', pTg)).toBeUndefined();
    await parent.press(mama(), '🔕 Отключить сообщения');
    expect(parent.tg.findButton('☑️ Отмена занятия', pTg)).toBeDefined(); // critical only within 48 h
    expect(parent.tg.findButton(/Завершение занятий/, pTg)).toBeUndefined();
    await parent.press(mama(), '☑️ Отмена занятия');
    await parent.press(mama(), '◀️ Назад');
    expect(last(parent, pTg)).toContain('Отключённые копии (некритичные): Отмена занятия');
    await parent.press(mama(), '🌙 Тихие часы');
    await parent.press(mama(), '☑️ Тихие часы');
    expect(parent.tg.findButton('⬜ Тихие часы', pTg)).toBeDefined();
  });
});
