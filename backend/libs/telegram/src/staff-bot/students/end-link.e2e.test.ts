import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '@test/app.js';
import { createBotHarness, type BotHarness } from '@test/bot.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount, nextTelegramUserId } from '@test/factories.js';
import { drainOutbox } from '@test/outbox.js';
import { linkStudent } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { notification } from '@modules/notifications/schema.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { GroupsUseCase } from '@modules/people/groups/groups.use-case.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { StudentBot } from '../../student-bot/student-bot.js';
import { TelegramModule } from '../../telegram.module.js';
import { StaffBot } from '../staff-bot.js';

describe('UC-33: teacher ends the link; the student sees the archive (5.8.4, ACC-04)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let staff: BotHarness;
  let studentBot: BotHarness;
  let teacherId: string;
  let studentId: string;
  let studentTg: number;
  let linkId: string;
  const tg = nextTelegramUserId();
  const teacher = () => ({ id: tg, first_name: 'Анна' });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [PeopleModule, AccessModule, NotificationsModule, TelegramModule]);
    staff = createBotHarness(ctx.get(StaffBot), ctx.get(ActorResolver));
    studentBot = createBotHarness(ctx.get(StudentBot), ctx.get(ActorResolver));
    teacherId = (
      await createAccount(tdb.txm, {
        telegramUserId: tg,
        roles: ['TEACHER'],
        firstName: 'Анна',
        lastName: 'Петровна',
      })
    ).id;
    await ctx.get(TeacherProfileRepository).upsert(teacherId, {
      defaultNoticeText: 'К сожалению, занятия прекращаются.',
      onboardedAt: ctx.clock.now(),
    });
    const student = await createAccount(tdb.txm, {
      roles: ['STUDENT'],
      firstName: 'Петя',
      lastName: 'Иванов',
    });
    studentId = student.id;
    studentTg = student.telegramUserId;
    linkId = (await linkStudent(ctx, teacherId, studentId)).id;
    const parent = await createAccount(tdb.txm, { roles: ['PARENT'], firstName: 'Мария' });
    await ctx.get(FamilyLinkRepository).insert({
      parentId: parent.id,
      studentId,
      invitedBy: teacherId,
      invitationId: null,
      confirmedAt: ctx.clock.now(),
    });
    const actor = {
      accountId: teacherId,
      roles: ['TEACHER'] as const,
      status: 'active' as const,
      source: 'bot' as const,
    };
    const group = await ctx.get(GroupsUseCase).create(actor, { name: '10А' });
    await ctx.get(GroupsUseCase).addMember(actor, group.id, studentId);
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('card → Завершить занятия → default text → consequences → confirm; notifications; archive for the student', async () => {
    await staff.text(teacher(), '/menu');
    await staff.press(teacher(), '👥 Ученики');
    await staff.press(teacher(), 'Петя Иванов');
    await staff.press(teacher(), '⛔ Завершить занятия');
    expect(staff.tg.sentTexts(tg).at(-1)).toContain('Завершение занятий с Петя Иванов');
    await staff.press(teacher(), /К сожалению, занятия прекращаются/);
    const confirm = staff.tg.sentTexts(tg).at(-1)!;
    expect(confirm).toContain('выйдет из групп — 1');
    expect(confirm).toContain('родителей получат уведомление — 1');
    await staff.press(teacher(), 'Завершить занятия');
    expect(staff.tg.sentTexts(tg).at(-1)).toContain('Занятия с Петя Иванов завершены');

    const link = (await ctx.get(TeacherStudentRepository).findById(linkId))!;
    expect(link).toMatchObject({
      status: 'ended',
      endReason: 'removed_by_teacher',
      endMessage: 'К сожалению, занятия прекращаются.',
    });
    expect((await ctx.get(TeacherStudentRepository).listPeriods(linkId))[0]!.endedAt).not.toBeNull();
    await drainOutbox(ctx, tdb);
    const rows = await tdb.db.select().from(notification).where(eq(notification.typeCode, 'link.ended'));
    expect(rows.map((r) => r.bot).sort()).toEqual(['parent', 'student']); // the acting teacher is not notified
    expect(rows.find((r) => r.bot === 'student')!.payload).toMatchObject({
      view: 'student',
      reason: 'учитель завершил занятия',
    });

    // teacher: the card moved to the archive and is read-only
    await staff.text(teacher(), '/menu');
    await staff.press(teacher(), '👥 Ученики');
    expect(staff.tg.sentTexts(tg).at(-1)).toContain('Пока нет учеников');
    await staff.press(teacher(), /Архив \(1\)/);
    await staff.press(teacher(), 'Петя Иванов');
    expect(staff.tg.sentTexts(tg).at(-1)).toContain('учитель завершил занятия');
    expect(staff.tg.findButton(/Псевдоним/, tg)).toBeUndefined();

    // student: not in "Мои учителя", present in "Архив"
    const student = { id: studentTg, first_name: 'Петя' };
    await studentBot.text(student, '/menu');
    await studentBot.press(student, '👩‍🏫 Мои учителя');
    expect(studentBot.tg.sentTexts(studentTg).at(-1)).toContain('Пока нет активных учителей');
    await studentBot.press(student, '◀️ Назад');
    await studentBot.press(student, '🗂 Архив');
    await studentBot.press(student, 'Анна Петровна');
    expect(studentBot.tg.sentTexts(studentTg).at(-1)).toContain('Статус: учитель завершил занятия');
  });

  it('ACC-04: a blocked teacher shows up in the student archive; a blocked student sees nothing (ACC-01)', async () => {
    const other = await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Олег', lastName: 'Блок' });
    await linkStudent(ctx, other.id, studentId);
    const student = { id: studentTg, first_name: 'Петя' };
    await studentBot.text(student, '/menu');
    await studentBot.press(student, '👩‍🏫 Мои учителя');
    expect(studentBot.tg.findButton('Олег Блок', studentTg)).toBeDefined();
    await ctx.get(AccountRepository).update(other.id, { status: 'blocked' });
    await studentBot.text(student, '/menu');
    await studentBot.press(student, '👩‍🏫 Мои учителя');
    expect(studentBot.tg.findButton('Олег Блок', studentTg)).toBeUndefined();
    await studentBot.press(student, '◀️ Назад');
    await studentBot.press(student, '🗂 Архив');
    await studentBot.press(student, 'Олег Блок');
    expect(studentBot.tg.sentTexts(studentTg).at(-1)).toContain('доступ учителя ограничен');

    await ctx.get(AccountRepository).update(studentId, { status: 'blocked' });
    await studentBot.text(student, '/menu');
    expect(studentBot.tg.sentTexts(studentTg).at(-1)).toContain('Доступ ограничен');
    await studentBot.callback(student, 's:archive:list');
    expect(studentBot.tg.calls.at(-1)).toMatchObject({
      method: 'answerCallbackQuery',
      payload: { show_alert: true },
    });
    await ctx.get(AccountRepository).update(studentId, { status: 'active' });
  });
});
