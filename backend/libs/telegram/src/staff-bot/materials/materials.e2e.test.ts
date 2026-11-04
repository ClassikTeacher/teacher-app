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
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { notification } from '@modules/notifications/schema.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { BotApiModule } from '@telegram/api/bot-api.module.js';
import { TelegramModule } from '../../telegram.module.js';
import { StudentBot } from '../../student-bot/student-bot.js';
import { StaffBot } from '../staff-bot.js';

const PDF = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj << /Type /Catalog >> endobj\n', 'latin1');

describe('UC-25 e2e: a file from StaffBot becomes a material, is granted and reaches the student in StudentBot', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let staff: BotHarness;
  let student: BotHarness;
  let teacherId: string;
  let petyaId: string;
  const teacherTg = nextTelegramUserId();
  const petyaTg = nextTelegramUserId();
  const teacher = () => ({ id: teacherTg, first_name: 'Анна' });
  const petya = () => ({ id: petyaTg, first_name: 'Петя' });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [
      PeopleModule,
      AccessModule,
      ScheduleModule,
      FilesModule,
      ContentModule,
      BotApiModule,
      NotificationsModule,
      TelegramModule,
    ]);
    ctx.get(TelegramFileDownloader).transport = async () => PDF;
    staff = createBotHarness(ctx.get(StaffBot), ctx.get(ActorResolver));
    student = createBotHarness(ctx.get(StudentBot), ctx.get(ActorResolver));
    teacherId = (
      await createAccount(tdb.txm, {
        telegramUserId: teacherTg,
        roles: ['TEACHER'],
        firstName: 'Анна',
        lastName: 'Петрова',
      })
    ).id;
    await ctx
      .get(TeacherProfileRepository)
      .upsert(teacherId, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now() });
    petyaId = (
      await createAccount(tdb.txm, {
        telegramUserId: petyaTg,
        roles: ['STUDENT'],
        firstName: 'Петя',
        lastName: 'Иванов',
      })
    ).id;
    await linkStudent(ctx, teacherId, petyaId);
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('teacher sends a PDF → title → grant to Petya; Petya opens «Материалы» and receives the document', async () => {
    await staff.text(teacher(), '/menu');
    await staff.press(teacher(), '📚 Материалы');
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('Библиотека пуста');
    // the file is sent straight into the chat (5.9.1), no button needed
    await staff.handle({
      update_id: 900_001,
      message: {
        message_id: 5001,
        date: 1_700_000_000,
        chat: { id: teacherTg, type: 'private', first_name: 'Анна' },
        from: { id: teacherTg, is_bot: false, first_name: 'Анна' },
        document: {
          file_id: 'tg-pdf-1',
          file_unique_id: 'u-pdf-1',
          file_name: 'Формулы.pdf',
          file_size: PDF.length,
        },
      },
    });
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('Как назвать материал');
    await staff.press(teacher(), 'Оставить имя файла');
    expect(staff.tg.sentTexts(teacherTg).at(-2)).toContain('Материал «Формулы» добавлен');
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('Кому выдать');
    await staff.press(teacher(), /Петя/);
    await staff.press(teacher(), 'Сейчас');
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('Выдано');
    await drainOutbox(ctx, tdb);
    const sent = await tdb.db
      .select()
      .from(notification)
      .where(eq(notification.typeCode, 'material.granted'));
    expect(sent.map((n) => n.recipientId)).toEqual([petyaId]);

    await student.text(petya(), '/menu');
    await student.press(petya(), '📚 Материалы');
    expect(student.tg.sentTexts(petyaTg).at(-1)).toContain('Материалы · Анна Петрова');
    await student.press(petya(), /Формулы/);
    expect(student.tg.sentTexts(petyaTg).at(-1)).toContain('Формулы');
    // the document goes to StudentBot from S3 (not the staff bot's file_id); the second time from the cache
    const docs = student.tg.sentDocuments(petyaTg);
    expect(docs.length).toBe(1);
    expect(docs[0]).not.toBe('tg-pdf-1');
    await student.press(petya(), '◀️ Назад');
    await student.press(petya(), /Формулы/); // opened again: the cached StudentBot file_id is re-sent
    expect(student.tg.sentDocuments(petyaTg).at(-1)).toMatch(/^doc-/);

    // the teacher sees the view mark and can revoke; the student loses access (MAT-02)
    await staff.text(teacher(), '/menu');
    await staff.press(teacher(), '📚 Материалы');
    await staff.press(teacher(), /Формулы/);
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('Просмотрели: 1');
    await staff.press(teacher(), /Выдачи/);
    await staff.press(teacher(), /Петя/);
    await student.press(petya(), '◀️ Назад');
    expect(student.tg.sentTexts(petyaTg).at(-1)).toContain('Пока ничего не выдано');
  });
});
