import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@test/app.js';
import { createBotHarness, type BotHarness } from '@test/bot.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount, nextTelegramUserId } from '@test/factories.js';
import { linkStudent, MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { StudentProfileRepository } from '@modules/people/student-profile.repository.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { TeacherSettingsUseCase } from '@modules/people/teacher-settings.use-case.js';
import { TelegramModule } from '../../telegram.module.js';
import { StaffBot } from '../staff-bot.js';

describe('StaffBot: «Настройки» and student card editing (M2-04)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let h: BotHarness;
  let teacherId: string;
  let linkId: string;
  const tg = nextTelegramUserId();
  const teacher = () => ({ id: tg, first_name: 'Анна' });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [PeopleModule, AccessModule, TelegramModule]);
    h = createBotHarness(ctx.get(StaffBot), ctx.get(ActorResolver));
    teacherId = (await createAccount(tdb.txm, { telegramUserId: tg, roles: ['TEACHER'], firstName: 'Анна' }))
      .id;
    await ctx
      .get(TeacherProfileRepository)
      .upsert(teacherId, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now() });
    const student = await createAccount(tdb.txm, {
      roles: ['STUDENT'],
      firstName: 'Петя',
      lastName: 'Иванов',
    });
    linkId = (await linkStudent(ctx, teacherId, student.id)).id;
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('edits card fields, subjects (with journals hook) and the calendar override from the card', async () => {
    await h.text(teacher(), '/menu');
    await h.press(teacher(), '👥 Ученики');
    await h.press(teacher(), 'Петя Иванов');
    await h.press(teacher(), '✏️ Псевдоним');
    await h.text(teacher(), 'Петруша');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Сохранено');
    await h.press(teacher(), '◀️ Назад');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('<b>Петруша</b> (Петя Иванов)');
    await h.press(teacher(), '🔢 Лимит в неделю');
    await h.press(teacher(), 'без лимита');
    await h.press(teacher(), '◀️ Назад');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Лимит занятий в неделю: без лимита');
    await h.press(teacher(), '✏️ Класс');
    await h.text(teacher(), '10');
    await h.press(teacher(), '◀️ Назад');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Класс: 10');
    expect(
      (
        await ctx
          .get(StudentProfileRepository)
          .find((await ctx.get(TeacherStudentRepository).findById(linkId))!.studentId!)
      )?.grade,
    ).toBe('10');

    await h.press(teacher(), '📖 Предметы');
    await h.press(teacher(), 'Физика');
    expect(h.tg.findButton('✅ Физика', tg)).toBeDefined();
    await h.press(teacher(), '✅ Математика');
    await h.press(teacher(), '✅ Физика'); // the last subject cannot be removed
    const alert = h.tg.calls.filter((c) => c.method === 'answerCallbackQuery').at(-1);
    expect(alert?.payload['text']).toContain('хотя бы один');
    expect((await ctx.get(TeacherStudentRepository).findById(linkId))?.subjectIds).toHaveLength(1);

    // a button from a stale subjects screen (catalogue reference mismatch) is refused, not applied
    await h.callback(teacher(), `s:students:subj:${linkId}:0:zzzz`);
    const stale = h.tg.calls.filter((c) => c.method === 'answerCallbackQuery').at(-1);
    expect(stale?.payload['text']).toContain('устарела');
    expect((await ctx.get(TeacherStudentRepository).findById(linkId))?.subjectIds).toHaveLength(1);

    await h.press(teacher(), '◀️ Назад');
    await h.press(teacher(), '📅 Календарь: как у всех');
    expect(h.tg.findButton('📅 Календарь: открыт', tg)).toBeDefined();
    await h.press(teacher(), '📅 Календарь: открыт');
    expect(h.tg.findButton('📅 Календарь: закрыт', tg)).toBeDefined();
    expect((await ctx.get(TeacherStudentRepository).findById(linkId))?.calendarOpen).toBe(false);
  });

  it('changes settings: timezone, buffers, cancellation toggles, notice text and templates', async () => {
    await h.text(teacher(), '/menu');
    await h.press(teacher(), '⚙️ Настройки');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Длительность занятия: 60 мин');
    await h.press(teacher(), '🕒 Часовой пояс');
    await h.text(teacher(), 'Nowhere/City');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Не узнаю');
    await h.text(teacher(), 'Europe/Moscow');
    await h.press(teacher(), '◀️ Назад');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Europe/Moscow');

    await h.press(teacher(), '↔️ Буферы');
    await h.press(teacher(), /До занятия/);
    await h.text(teacher(), '500');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('от 0 до 120');
    await h.text(teacher(), '15');
    await h.press(teacher(), '◀️ Назад');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('буферы: 15 / 0 мин');

    await h.press(teacher(), '❌ Отмены учениками');
    await h.press(teacher(), /Ученик может отменять/);
    expect(h.tg.findButton(/⚪️ Ученик может отменять/, tg)).toBeDefined();
    expect((await ctx.get(TeacherProfileRepository).find(teacherId))?.studentCanCancel).toBe(false);
    await h.press(teacher(), '⏳ Срок отмены учеником');
    await h.text(teacher(), '12');
    await h.press(teacher(), '◀️ Назад');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('не позднее чем за 12 ч');

    await h.press(teacher(), '📋 Шаблоны причин');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Шаблонов пока нет');
    await h.press(teacher(), '➕ Добавить шаблон');
    await h.text(teacher(), 'Болею, перенесём');
    await h.press(teacher(), '◀️ Назад');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('1. Болею, перенесём');
    await h.press(teacher(), '🗑 1');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Шаблонов пока нет');

    // cancel leaves a dialog without saving
    await h.press(teacher(), '◀️ Назад');
    await h.press(teacher(), '💬 Текст по умолчанию');
    await h.press(teacher(), 'Отмена');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Диалог прерван');
    await h.text(teacher(), 'не должно сохраниться');
    expect((await ctx.get(TeacherProfileRepository).find(teacherId))?.defaultNoticeText).not.toContain(
      'не должно',
    );
  });

  it('refuses the 21st template and drops the dialog', async () => {
    const settings = ctx.get(TeacherSettingsUseCase);
    const actor = {
      accountId: teacherId,
      roles: ['TEACHER'] as const,
      status: 'active' as const,
      source: 'bot' as const,
    };
    for (let i = 0; i < 20; i += 1) await settings.addTemplate(actor, 'cancel_reason', `Шаблон ${i}`);
    await h.text(teacher(), '/menu');
    await h.press(teacher(), '⚙️ Настройки');
    await h.press(teacher(), '📋 Шаблоны причин');
    await h.press(teacher(), '➕ Добавить шаблон');
    await h.text(teacher(), 'двадцать первый');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Достигнут лимит');
    await h.text(teacher(), 'ещё раз');
    expect(h.tg.sentTexts(tg).at(-1)).not.toContain('Достигнут лимит'); // the dialog is gone: plain fallback
  });

  it('«Запись» (M4-04, 5.5.5): confirmation toggle, grid step, notice, horizon, durations, pending limit', async () => {
    await h.text(teacher(), '/menu');
    await h.press(teacher(), '⚙️ Настройки');
    await h.press(teacher(), '📝 Запись');
    const screen = () => h.tg.sentTexts(tg).at(-1)!;
    expect(screen()).toContain('Подтверждение заявок: без подтверждения');
    expect(screen()).toContain('Минимальный срок до начала: 12 ч');
    expect(screen()).toContain('Длительности: по умолчанию (60 мин)');
    await h.press(teacher(), 'Подтверждение: нет');
    expect(screen()).toContain('Подтверждение заявок: вручную');
    await h.press(teacher(), 'Шаг: 30 мин');
    expect(screen()).toContain('Шаг сетки: 60 мин');
    await h.press(teacher(), 'Мин. срок');
    await h.text(teacher(), '400');
    expect(screen()).toContain('от 0 до 336');
    await h.text(teacher(), '24');
    expect(screen()).toContain('Сохранено');
    await h.press(teacher(), '◀️ Назад');
    expect(screen()).toContain('Минимальный срок до начала: 24 ч');
    await h.press(teacher(), 'Длительности');
    await h.text(teacher(), '45, 60, 90');
    await h.press(teacher(), '◀️ Назад');
    expect(screen()).toContain('Длительности: 45, 60, 90');
    await h.press(teacher(), 'Заявок на слот');
    await h.text(teacher(), '3');
    await h.press(teacher(), '◀️ Назад');
    expect(screen()).toContain('Заявок на один слот (режим с подтверждением): 3');
    const profile = (await ctx.get(TeacherProfileRepository).find(teacherId))!;
    expect(profile.bookingConfirmation).toBe('manual');
    expect(profile.bookingRules).toEqual({
      gridStepMin: 60,
      minNoticeHours: 24,
      durations: [45, 60, 90],
      maxPendingPerSlot: 3,
    });
  });
});
