import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '@test/app.js';
import { createBotHarness, type BotHarness } from '@test/bot.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount, nextTelegramUserId } from '@test/factories.js';
import { drainOutbox } from '@test/outbox.js';
import { linkStudent, MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import { ContentModule } from '@modules/content/content.module.js';
import { FilesModule } from '@modules/files/files.module.js';
import { TelegramFileDownloader } from '@modules/files/telegram-file-downloader.js';
import { GradeEntriesUseCase } from '@modules/gradebook/grade-entries.use-case.js';
import { GradeEntryRepository } from '@modules/gradebook/grade-entry.repository.js';
import { GradebookModule } from '@modules/gradebook/gradebook.module.js';
import { JournalsUseCase } from '@modules/gradebook/journals.use-case.js';
import { HomeworkModule } from '@modules/homework/homework.module.js';
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { notification } from '@modules/notifications/schema.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { CreateLessonUseCase } from '@modules/schedule/lessons/create-lesson.use-case.js';
import { LessonReportUseCase } from '@modules/schedule/lessons/lesson-report.use-case.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { BotApiModule } from '@telegram/api/bot-api.module.js';
import { TelegramModule } from '../../telegram.module.js';
import { StaffBot } from '../staff-bot.js';

type TgUser = { id: number; first_name: string };
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

describe('UC-29 e2e: journals in StaffBot — records, scale, test kinds, visibility, proposals, lesson marks', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let staff: BotHarness;
  let teacherId: string;
  let petyaId: string;
  let mashaId: string;
  const teacherTg = nextTelegramUserId();
  const teacher = (): TgUser => ({ id: teacherTg, first_name: 'Анна' });
  const last = () => staff.tg.sentTexts(teacherTg).at(-1) ?? '';

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
    ctx.get(TelegramFileDownloader).transport = async () => JPG;
    staff = createBotHarness(ctx.get(StaffBot), ctx.get(ActorResolver));
    teacherId = (
      await createAccount(tdb.txm, {
        telegramUserId: teacherTg,
        roles: ['TEACHER'],
        firstName: 'Анна',
        lastName: 'Петрова',
        timezone: 'Europe/Minsk',
      })
    ).id;
    await ctx
      .get(TeacherProfileRepository)
      .upsert(teacherId, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now() });
    petyaId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Петя', lastName: 'Иванов' }))
      .id;
    mashaId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Маша', lastName: 'Смирнова' }))
      .id;
    const journals = ctx.get(JournalsUseCase);
    for (const studentId of [petyaId, mashaId]) {
      const link = await linkStudent(ctx, teacherId, studentId, { maxLessonsPerWeek: null });
      await journals.ensureForLink({ linkId: link.id, teacherId, studentId, subjectIds: link.subjectIds });
    }
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('adds a school mark by buttons, shows the statistics and edits and deletes the record', async () => {
    await staff.text(teacher(), '/menu');
    await staff.press(teacher(), '📊 Журналы и отчёты');
    expect(last()).toContain('Выберите ученика');
    await staff.press(teacher(), /Петя/);
    expect(last()).toContain('Журналы: Петя');
    await staff.press(teacher(), /Школьные отметки/);
    expect(last()).toContain('Записей пока нет');
    await staff.press(teacher(), '➕ Добавить');
    expect(last()).toContain('Какая отметка');
    await staff.press(teacher(), '8');
    expect(last()).toContain('Какая работа');
    await staff.press(teacher(), 'контрольная');
    expect(last()).toContain('За какой день');
    await staff.press(teacher(), 'Сегодня');
    expect(last()).toContain('Комментарий');
    await staff.text(teacher(), 'Молодец');
    expect(last()).toContain('Отметка записана');
    await staff.press(teacher(), '◀️ Назад');
    expect(last()).toContain('средний балл: <b>8</b>');
    expect(last()).toContain('04.11 · <b>8</b> · контрольная · Молодец');
    // a typed value out of scale is refused, a valid one is accepted on the second try
    await staff.press(teacher(), '➕ Добавить');
    await staff.text(teacher(), '11');
    expect(last()).toContain('Не понял значение');
    await staff.text(teacher(), '6');
    await staff.press(teacher(), 'текущая');
    await staff.text(teacher(), '03.11');
    await staff.press(teacher(), 'Пропустить');
    expect(last()).toContain('Отметка записана');
    await staff.press(teacher(), '◀️ Назад');
    expect(last()).toContain('средний балл: <b>7</b>');
    // the record card: edit the value, then delete
    await staff.press(teacher(), /03\.11 · 6/);
    expect(last()).toContain('Значение: <b>6</b>');
    await staff.press(teacher(), '✏️ Изменить');
    await staff.press(teacher(), '7');
    await staff.press(teacher(), 'самостоятельная');
    await staff.press(teacher(), 'Пропустить');
    expect(last()).toContain('Запись изменена');
    await staff.press(teacher(), '◀️ Назад');
    expect(last()).toContain('Значение: <b>7</b>');
    await staff.press(teacher(), '🗑 Удалить');
    await staff.press(teacher(), 'Да');
    expect(last()).toContain('средний балл: <b>8</b>');
    await drainOutbox(ctx, tdb);
    const toPetya = await tdb.db.select().from(notification).where(eq(notification.recipientId, petyaId));
    // the deleted record never reached the student (removed before delivery); the first one did
    expect(toPetya.filter((n) => n.typeCode === 'grade.added')).toHaveLength(1);
  });

  it('JRN-04: toggles visibility and hides the journal; the custom scale and test kinds are managed from the root', async () => {
    await staff.press(teacher(), '☑️ Видит ученик');
    expect(staff.tg.findButton(/⬜ Видит ученик/, teacherTg)).toBeTruthy();
    await staff.press(teacher(), '⬜ Видит ученик');
    expect(staff.tg.findButton(/☑️ Видит ученик/, teacherTg)).toBeTruthy();
    await staff.press(teacher(), '🙈 Скрыть журнал');
    expect(last()).toContain('🙈');
    await staff.press(teacher(), '👁 Показать журнал');
    // the scale
    await staff.text(teacher(), '/menu');
    await staff.press(teacher(), '📊 Журналы и отчёты');
    await staff.press(teacher(), '🌟 Моя шкала');
    expect(last()).toContain('Шкала не задана');
    await staff.press(teacher(), '✏️ Задать шкалу');
    await staff.text(teacher(), 'одно значение');
    expect(staff.tg.sentTexts(teacherTg).at(-2)).toContain('Не получилось');
    await staff.text(teacher(), '⭐ Отлично = 3\n👍 Хорошо = 2\n💪 Старайся');
    expect(last()).toContain('значений — 3');
    await staff.press(teacher(), '◀️ Назад');
    expect(last()).toContain('⭐ Отлично (3)');
    await staff.press(teacher(), '🙈 💪 Старайся');
    expect(last()).not.toContain('Старайся');
    // test kinds
    await staff.press(teacher(), '◀️ Назад');
    await staff.press(teacher(), '📈 Виды тестов');
    expect(last()).toContain('ЦТ');
    await staff.press(teacher(), '➕ Добавить вид');
    await staff.text(teacher(), 'Олимпиада');
    expect(last()).toContain('«Олимпиада» добавлен');
    await staff.press(teacher(), '◀️ Назад');
    await staff.press(teacher(), '🗑 Олимпиада');
    expect(last()).not.toContain('Олимпиада');
    // a custom mark and a test score with the ▲▼ dynamics
    await staff.press(teacher(), '◀️ Назад');
    await staff.press(teacher(), /Петя/);
    await staff.press(teacher(), /Мой журнал/);
    await staff.press(teacher(), '➕ Добавить');
    await staff.press(teacher(), '⭐ Отлично');
    await staff.press(teacher(), 'Сегодня');
    await staff.press(teacher(), 'Пропустить');
    await staff.press(teacher(), '◀️ Назад');
    expect(last()).toContain('⭐ Отлично × 1');
    await staff.press(teacher(), '◀️ Назад');
    await staff.press(teacher(), /Тесты/);
    await staff.press(teacher(), '🎯 Цель');
    await staff.text(teacher(), '80');
    expect(last()).toContain('Цель установлена: 80 %');
    await staff.press(teacher(), '◀️ Назад');
    await staff.press(teacher(), '➕ Добавить');
    await staff.text(teacher(), '60');
    await staff.press(teacher(), 'ЦТ');
    await staff.text(teacher(), '01.10');
    await staff.press(teacher(), 'Пропустить'); // comment
    expect(last()).toContain('скан бланка');
    await staff.press(teacher(), 'Пропустить'); // file
    await staff.press(teacher(), '◀️ Назад');
    await staff.press(teacher(), '➕ Добавить');
    await staff.text(teacher(), '42/60 (30+12)');
    await staff.press(teacher(), 'ЦТ');
    await staff.press(teacher(), 'Сегодня');
    await staff.press(teacher(), 'Пропустить');
    // 5.11.3 «вложение»: the scanned sheet arrives as a photo and follows the record card as a document
    await staff.handle({
      update_id: 990_001,
      message: {
        message_id: 990_001,
        date: 1_700_000_000,
        chat: { id: teacherTg, type: 'private' as const, first_name: 'Анна' },
        from: { id: teacherTg, is_bot: false, first_name: 'Анна' },
        photo: [
          { file_id: 'tg-scan', file_unique_id: 'u-scan', width: 10, height: 10, file_size: JPG.length },
        ],
      },
    });
    expect(last()).toContain('Отметка записана');
    await staff.press(teacher(), '◀️ Назад');
    expect(last()).toContain('последний: <b>42/60 (70 %)</b> ▲ +10');
    expect(last()).toContain('цель: 80 % (▼ −10)');
    expect(last()).toContain('04.11 · <b>42/60 (70 %)</b> · ▲ +10 · ЦТ');
    const before = staff.tg.sentDocuments(teacherTg).length;
    await staff.press(teacher(), /04\.11 · 42\/60/);
    expect(staff.tg.sentDocuments(teacherTg).length).toBe(before + 1);
  });

  it('UC-30: a proposed mark is confirmed from the notification button; a second press is stale', async () => {
    const school = await ctx
      .get(GradeEntriesUseCase)
      .journalFor(
        { accountId: teacherId, roles: ['TEACHER'], status: 'active', source: 'bot' },
        petyaId,
        MATH_ID,
        'school',
      );
    const proposed = await ctx
      .get(GradeEntriesUseCase)
      .propose(
        { accountId: petyaId, roles: ['STUDENT'], status: 'active', source: 'bot' },
        { journalId: school.id, value: 9, category: 'control' },
      );
    await staff.text(teacher(), '/menu');
    await staff.press(teacher(), '📊 Журналы и отчёты');
    expect(staff.tg.findButton(/Подтвердить \(1\)/, teacherTg)).toBeTruthy();
    await staff.callback(teacher(), `s:journals:ok:${proposed.id}`);
    expect(staff.tg.sentTexts(teacherTg).some((t) => t.includes('подтверждена'))).toBe(true);
    expect(last()).toContain('<b>9</b> · контрольная · внёс ученик');
    await staff.callback(teacher(), `s:journals:ok:${proposed.id}`);
    expect(staff.tg.sentTexts(teacherTg).at(-2)).toContain('Кнопка устарела');
  });

  it('5.6.4: «⭐ Отметки» after the lesson report grades every participant of a group lesson in turn', async () => {
    const actor = {
      accountId: teacherId,
      roles: ['TEACHER'] as const,
      status: 'active' as const,
      source: 'bot' as const,
    };
    const lessons = ctx.get(CreateLessonUseCase);
    const created = await lessons.execute(actor, {
      target: { studentId: petyaId },
      startsAt: new Date('2026-11-04T13:00:00Z'),
      durationMin: 60,
    });
    ctx.clock.set('2026-11-04T15:00:00Z');
    await ctx.get(LessonReportUseCase).complete(actor, created.lesson.id, {
      topic: 'Дроби',
      attendance: [{ studentId: petyaId, attendance: 'present' }],
    });
    await staff.callback(teacher(), `s:journals:lesson:${created.lesson.id}`);
    expect(last()).toContain('В какой журнал записать');
    await staff.press(teacher(), /Школьные отметки/);
    await staff.press(teacher(), '10');
    await staff.press(teacher(), 'текущая');
    // the date comes from the lesson: no date step
    expect(last()).toContain('Комментарий');
    await staff.press(teacher(), 'Пропустить');
    expect(last()).toContain('Отметка записана');
    const school = await ctx.get(GradeEntriesUseCase).journalFor(actor, petyaId, MATH_ID, 'school');
    const rows = await ctx.get(GradeEntryRepository).listByJournal(school.id);
    expect(rows.at(-1)).toMatchObject({ valueNumeric: 10, lessonId: created.lesson.id, date: '2026-11-04' });
  });
});
