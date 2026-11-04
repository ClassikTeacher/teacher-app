import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { HOUR_MS } from '@shared/time/clock.js';
import { createTestContext, type TestContext } from '@test/app.js';
import { createBotHarness, type BotHarness } from '@test/bot.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { drainOutbox } from '@test/outbox.js';
import { createAccount, nextTelegramUserId } from '@test/factories.js';
import { MATH_ID, PHYSICS_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import { FeatureAdminUseCase } from '@modules/access/features/feature-admin.use-case.js';
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { notification } from '@modules/notifications/schema.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { StudentBot } from '../../student-bot/student-bot.js';
import { TelegramModule } from '../../telegram.module.js';
import { StaffBot } from '../staff-bot.js';

describe('UC-10: teacher invites a student by personal link; student accepts in StudentBot', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let staff: BotHarness;
  let studentBot: BotHarness;
  let teacherId: string;
  let adminId: string;
  const teacherTg = nextTelegramUserId();
  const teacher = () => ({ id: teacherTg, first_name: 'Анна', username: 'anna' });
  const linkOf = (text: string): string =>
    /https:\/\/t\.me\/TestStudentBot\?start=([A-Za-z0-9_-]{43})/.exec(text)![1]!;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [PeopleModule, AccessModule, NotificationsModule, TelegramModule]);
    staff = createBotHarness(ctx.get(StaffBot), ctx.get(ActorResolver));
    studentBot = createBotHarness(ctx.get(StudentBot), ctx.get(ActorResolver));
    teacherId = (
      await createAccount(tdb.txm, {
        telegramUserId: teacherTg,
        roles: ['TEACHER'],
        firstName: 'Анна',
        lastName: 'Петровна',
      })
    ).id;
    await ctx
      .get(TeacherProfileRepository)
      .upsert(teacherId, { subjectIds: [MATH_ID, PHYSICS_ID], onboardedAt: ctx.clock.now() });
    adminId = (await createAccount(tdb.txm, { roles: ['ADMIN'] })).id;
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  const deliverEvents = (): Promise<number> => drainOutbox(ctx, tdb);

  it('full path: card → link → accept → teacher notified with hints; the card shows the student', async () => {
    await staff.text(teacher(), '/menu');
    await staff.press(teacher(), '👥 Ученики');
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('Пока нет учеников');
    await staff.press(teacher(), '➕ Добавить ученика');
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('Новый ученик, шаг 1');
    expect(staff.tg.findButton('Химия', teacherTg)).toBeUndefined(); // only the teacher's own subjects
    await staff.press(teacher(), 'Готово');
    expect(staff.tg.calls.at(-1)?.payload['text']).toContain('хотя бы один'); // alert: a subject is required
    await staff.press(teacher(), 'Математика');
    await staff.press(teacher(), 'Готово');
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('Шаг 2');
    await staff.text(teacher(), '99');
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('от 1 до 50');
    await staff.press(teacher(), '3');
    await staff.text(teacher(), 'Петя');
    await staff.text(teacher(), '9');
    const card = staff.tg.sentTexts(teacherTg).at(-1)!;
    expect(card).toContain('Анна Петровна приглашает вас заниматься');
    expect(card).toContain('Для: Петя');
    expect(card).toContain('Лимит занятий в неделю: 3');
    const token = linkOf(card);

    await staff.press(teacher(), '👥 К ученикам');
    expect(staff.tg.findButton(/Ожидают \(1\)/, teacherTg)).toBeDefined();
    await staff.press(teacher(), /Ожидают/);
    expect(staff.tg.findButton(/Петя · ждёт принятия/, teacherTg)).toBeDefined();

    const student = { id: nextTelegramUserId(), first_name: 'Пётр', last_name: 'Иванов' };
    await studentBot.text(student, `/start ${token}`);
    await studentBot.press(student, '✅ Принять');
    await studentBot.press(student, /Оставить/);
    await studentBot.press(student, 'Пропустить'); // keeps the class typed by the teacher
    await studentBot.press(student, 'Europe/Minsk');
    await studentBot.press(student, 'Принимаю');
    expect(studentBot.tg.sentTexts(student.id).at(-1)).toContain('Вы занимаетесь у Анна Петровна');

    await deliverEvents();
    const rows = await tdb.db.select().from(notification).where(eq(notification.recipientId, teacherId));
    expect(rows.map((r) => r.typeCode)).toEqual(['link.student_joined']);
    expect(rows[0]!.bot).toBe('staff');
    expect(rows[0]!.payload).toMatchObject({ name: 'Пётр Иванов', subjects: 'Математика' });
    expect(rows[0]!.payload['buttons']).toEqual([
      { text: '👨‍👩‍👧 Пригласить родителя', data: expect.stringMatching(/^s:students:parents:/) },
      { text: '➕ Поставить занятие', data: expect.stringMatching(/^s:students:lesson:/) },
    ]);

    await staff.text(teacher(), '/menu');
    await staff.press(teacher(), '👥 Ученики');
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('Ученики</b> · 1');
    await staff.press(teacher(), 'Петя');
    const studentCard = staff.tg.sentTexts(teacherTg).at(-1)!;
    expect(studentCard).toContain('<b>Петя</b> (Пётр Иванов)');
    expect(studentCard).toContain('Класс: 9');
    expect(studentCard).toContain('занимается с');
    // the notification buttons lead to the card screens
    await staff.callback(teacher(), (rows[0]!.payload['buttons'] as Array<{ data: string }>)[0]!.data);
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('Родители ученика Петя');
  });

  it('5а: a declined invitation shows up as declined; the teacher re-issues it and later withdraws it', async () => {
    await staff.text(teacher(), '/menu');
    await staff.press(teacher(), '👥 Ученики');
    await staff.press(teacher(), '➕ Добавить ученика');
    await staff.press(teacher(), 'Физика');
    await staff.press(teacher(), 'Готово');
    await staff.press(teacher(), 'без лимита');
    await staff.text(teacher(), 'Вася');
    await staff.press(teacher(), 'Пропустить');
    const token = linkOf(staff.tg.sentTexts(teacherTg).at(-1)!);
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('Без лимита занятий в неделю');

    const guest = { id: nextTelegramUserId(), first_name: 'Гость' };
    await studentBot.text(guest, `/start ${token}`);
    await studentBot.press(guest, '❌ Отклонить');
    await deliverEvents();
    const rows = await tdb.db.select().from(notification).where(eq(notification.typeCode, 'link.declined'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ name: 'Вася' });

    await staff.text(teacher(), '/menu');
    await staff.press(teacher(), '👥 Ученики');
    await staff.press(teacher(), /Ожидают/);
    await staff.press(teacher(), /Вася · отклонил/);
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('Статус: отклонил(а)');
    await staff.press(teacher(), '🔁 Перевыпустить ссылку');
    const reissued = staff.tg.sentTexts(teacherTg).at(-1)!;
    expect(reissued).toContain('Для: Вася');
    expect(linkOf(reissued)).not.toBe(token);
    await studentBot.text(guest, `/start ${token}`); // the burnt token no longer leads to a card
    expect(studentBot.tg.sentTexts(guest.id).at(-1)).toContain('недействительно');

    await staff.press(teacher(), 'Отозвать приглашение');
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('Нет карточек');
    await studentBot.text(guest, `/start ${linkOf(reissued)}`);
    expect(studentBot.tg.sentTexts(guest.id).at(-1)).toContain('отозвано');
  });

  it('3а: the student limit blocks a new card; an expired card can be re-issued', async () => {
    const admin = {
      accountId: adminId,
      roles: ['ADMIN'] as const,
      status: 'active' as const,
      source: 'bot' as const,
    };
    await ctx.get(FeatureAdminUseCase).setTeacher(admin, teacherId, 'core', { limits: { maxStudents: 1 } });
    await staff.text(teacher(), '/menu');
    await staff.press(teacher(), '👥 Ученики');
    await staff.press(teacher(), '➕ Добавить ученика');
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('Достигнут лимит'); // before the dialog starts
    await staff.text(teacher(), 'Математика');
    expect(staff.tg.sentTexts(teacherTg).at(-1)).not.toContain('Шаг 2'); // no dialog is running
    expect(await ctx.get(TeacherStudentRepository).countByTeacher(teacherId, ['pending'])).toBe(0);
    await ctx
      .get(FeatureAdminUseCase)
      .setTeacher(admin, teacherId, 'core', { limits: { maxStudents: null } });

    await staff.text(teacher(), '/menu');
    await staff.press(teacher(), '👥 Ученики');
    await staff.press(teacher(), '➕ Добавить ученика');
    await staff.press(teacher(), 'Математика');
    await staff.press(teacher(), 'Готово');
    await staff.press(teacher(), '2');
    await staff.text(teacher(), 'Соня');
    await staff.press(teacher(), 'Пропустить');
    ctx.clock.advance(8 * 24 * HOUR_MS);
    try {
      await staff.text(teacher(), '/menu');
      await staff.press(teacher(), '👥 Ученики');
      await staff.press(teacher(), /Ожидают/);
      expect(staff.tg.findButton(/Соня · ссылка истекла/, teacherTg)).toBeDefined();
    } finally {
      ctx.clock.advance(-8 * 24 * HOUR_MS);
    }
  });

  it('refuses another teacher opening a card by a crafted callback', async () => {
    const other = await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Олег' });
    const links = await ctx.get(TeacherStudentRepository).listByTeacher(teacherId, ['active']);
    await staff.callback({ id: other.telegramUserId, first_name: 'Олег' }, `s:students:card:${links[0]!.id}`);
    expect(staff.tg.sentTexts(other.telegramUserId).at(-1)).toContain('Пока нет учеников');
  });
});
