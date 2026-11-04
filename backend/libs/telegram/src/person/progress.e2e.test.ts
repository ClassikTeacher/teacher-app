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
import { ContentModule } from '@modules/content/content.module.js';
import { FilesModule } from '@modules/files/files.module.js';
import { GradeEntriesUseCase } from '@modules/gradebook/grade-entries.use-case.js';
import { GradebookModule } from '@modules/gradebook/gradebook.module.js';
import { JournalsUseCase } from '@modules/gradebook/journals.use-case.js';
import { ReportsUseCase } from '@modules/gradebook/reports.use-case.js';
import { HomeworkModule } from '@modules/homework/homework.module.js';
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { notification } from '@modules/notifications/schema.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { BotApiModule } from '@telegram/api/bot-api.module.js';
import { ParentBot } from '../parent-bot/parent-bot.js';
import { StudentBot } from '../student-bot/student-bot.js';
import { TelegramModule } from '../telegram.module.js';

describe('UC-36 / UC-30 e2e: «Успеваемость» in StudentBot and ParentBot, reporting a mark, reports', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let student: BotHarness;
  let parent: BotHarness;
  let teacherId: string;
  let petyaId: string;
  let mamaId: string;
  let linkId: string;
  const sTg = nextTelegramUserId();
  const pTg = nextTelegramUserId();
  const petya = () => ({ id: sTg, first_name: 'Петя' });
  const mama = () => ({ id: pTg, first_name: 'Мария' });
  const last = (h: BotHarness, id: number) => h.tg.sentTexts(id).at(-1) ?? '';
  const teacher = (): Actor => ({
    accountId: teacherId,
    roles: ['TEACHER'],
    status: 'active',
    source: 'bot',
  });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(
      tdb,
      [
        PeopleModule,
        AccessModule,
        ScheduleModule,
        FilesModule,
        ContentModule,
        HomeworkModule,
        GradebookModule,
        BotApiModule,
        NotificationsModule,
        TelegramModule,
      ],
      { now: '2026-11-04T12:00:00Z' },
    );
    student = createBotHarness(ctx.get(StudentBot), ctx.get(ActorResolver));
    parent = createBotHarness(ctx.get(ParentBot), ctx.get(ActorResolver));
    teacherId = (
      await createAccount(tdb.txm, {
        roles: ['TEACHER'],
        firstName: 'Анна',
        lastName: 'Петрова',
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
        timezone: 'Europe/Minsk',
      })
    ).id;
    mamaId = (await createAccount(tdb.txm, { telegramUserId: pTg, roles: ['PARENT'], firstName: 'Мария' }))
      .id;
    await ctx.get(FamilyLinkRepository).insert({
      parentId: mamaId,
      studentId: petyaId,
      invitedBy: teacherId,
      invitationId: null,
      confirmedAt: ctx.clock.now(),
    });
    const link = await linkStudent(ctx, teacherId, petyaId, { maxLessonsPerWeek: null });
    linkId = link.id;
    await ctx
      .get(JournalsUseCase)
      .ensureForLink({ linkId, teacherId, studentId: petyaId, subjectIds: [MATH_ID] });
    const entries = ctx.get(GradeEntriesUseCase);
    const school = await entries.journalFor(teacher(), petyaId, MATH_ID, 'school');
    await entries.add(teacher(), { journalId: school.id, value: 8, date: '2026-11-02', comment: 'Молодец' });
    await entries.add(teacher(), { journalId: school.id, value: 6, category: 'control', date: '2026-11-03' });
    const tests = await entries.journalFor(teacher(), petyaId, MATH_ID, 'tests');
    await entries.add(teacher(), { journalId: tests.id, value: 70, date: '2026-10-20' });
    const custom = await entries.journalFor(teacher(), petyaId, MATH_ID, 'custom');
    await ctx.get(JournalsUseCase).updateSettings(teacher(), custom.id, { visibleToStudent: false });
    await drainOutbox(ctx, tdb);
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('StudentBot: journals by teacher respect visibility; the journal screen shows stats and records; the notification button opens it', async () => {
    await student.text(petya(), '/menu');
    await student.press(petya(), '📊 Успеваемость');
    expect(last(student, sTg)).toContain('Анна Петрова');
    expect(student.tg.findButton(/Школьные отметки \(2\)/, sTg)).toBeTruthy();
    expect(student.tg.findButton(/Тесты \(1\)/, sTg)).toBeTruthy();
    expect(student.tg.findButton(/Мой журнал|Журнал учителя/, sTg)).toBeUndefined(); // hidden from the student (JRN-04)
    await student.press(petya(), /Школьные отметки/);
    expect(last(student, sTg)).toContain('средний балл: <b>7</b>');
    expect(last(student, sTg)).toContain('02.11 · <b>8</b> · текущая · Молодец');
    expect(last(student, sTg)).toContain('03.11 · <b>6</b> · контрольная');
    // the «Открыть журнал» button of grade.added leads to the same screen
    const added = (
      await tdb.db.select().from(notification).where(eq(notification.recipientId, petyaId))
    ).find((n) => n.typeCode === 'grade.added' && n.payload['type'] === 'school')!;
    const button = (added.payload['buttons'] as Array<{ data: string }>)[0]!;
    await student.callback(petya(), button.data);
    expect(last(student, sTg)).toContain('Школьные отметки');
  });

  it('UC-30 in StudentBot: a reported mark waits for the teacher and shows up after confirmation', async () => {
    await student.press(petya(), '➕ Сообщить отметку');
    expect(last(student, sTg)).toContain('Какую отметку получили');
    await student.press(petya(), '9');
    await student.press(petya(), 'контрольная');
    await student.press(petya(), 'Вчера');
    await student.text(petya(), 'за дроби');
    expect(last(student, sTg)).toContain('отправлена учителю на подтверждение');
    await student.press(petya(), '◀️ Назад');
    expect(last(student, sTg)).not.toContain('<b>9</b>');
    const pending = (await ctx.get(GradeEntriesUseCase).journalFor(teacher(), petyaId, MATH_ID, 'school')).id;
    const entries = ctx.get(GradeEntriesUseCase);
    await drainOutbox(ctx, tdb);
    const proposed = (
      await tdb.db.select().from(notification).where(eq(notification.recipientId, teacherId))
    ).filter((n) => n.typeCode === 'grade.proposed');
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.payload).toMatchObject({ value: '9', by: 'Петя Иванов', source: 'student' });
    const entryId = (proposed[0]!.payload['buttons'] as Array<{ data: string }>)[0]!.data.split(':').at(-1)!;
    await entries.confirm(teacher(), entryId);
    await student.press(petya(), '◀️ Назад'); // the journal → the list
    await student.press(petya(), /Школьные отметки/);
    expect(last(student, sTg)).toContain('03.11 · <b>9</b> · контрольная · внёс ученик · за дроби');
    expect(pending).toBeTruthy();
  });

  it("ParentBot: the child's journals and a sent report open from the menu and from the copy notification", async () => {
    await ctx
      .get(ReportsUseCase)
      .send(
        teacher(),
        (
          await ctx
            .get(ReportsUseCase)
            .create(teacher(), { linkId, from: '2026-11-01', to: '2026-11-30', comment: 'Хорошо' })
        ).id,
      );
    await drainOutbox(ctx, tdb);
    await parent.text(mama(), '/menu');
    await parent.press(mama(), '📊 Успеваемость и отчёты');
    expect(last(parent, pTg)).toContain('Успеваемость: Петя Иванов');
    expect(last(parent, pTg)).toContain('Анна Петрова');
    expect(parent.tg.findButton(/Школьные отметки \(3\)/, pTg)).toBeTruthy();
    expect(parent.tg.findButton(/Журнал учителя/, pTg)).toBeTruthy(); // hidden from the student only
    await parent.press(mama(), /Школьные отметки/);
    expect(last(parent, pTg)).toContain('Петя Иванов');
    expect(parent.tg.findButton('➕ Сообщить отметку', pTg)).toBeTruthy();
    await parent.press(mama(), '◀️ Назад');
    await parent.press(mama(), '📄 Отчёты');
    expect(parent.tg.findButton(/01\.11\.2026 — 30\.11\.2026/, pTg)).toBeTruthy();
    await parent.press(mama(), /01\.11\.2026/);
    expect(last(parent, pTg)).toContain('Отчёт: Петя Иванов');
    expect(last(parent, pTg)).toContain('Комментарий учителя:</b> Хорошо');
    const copy = (await tdb.db.select().from(notification).where(eq(notification.recipientId, mamaId))).find(
      (n) => n.typeCode === 'report.sent',
    )!;
    expect(copy.route).toBe('cc');
    await parent.callback(mama(), (copy.payload['buttons'] as Array<{ data: string }>)[0]!.data);
    expect(last(parent, pTg)).toContain('Отчёт: Петя Иванов');
  });
});
