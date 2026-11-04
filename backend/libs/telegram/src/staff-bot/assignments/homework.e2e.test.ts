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
import { HomeworkModule } from '@modules/homework/homework.module.js';
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
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0]);
type TgUser = { id: number; first_name: string };

describe('UC-26/27/28 e2e: teacher assigns in StaffBot, student submits files and text, teacher reviews', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let staff: BotHarness;
  let student: BotHarness;
  let teacherId: string;
  let petyaId: string;
  const teacherTg = nextTelegramUserId();
  const petyaTg = nextTelegramUserId();
  const teacher = (): TgUser => ({ id: teacherTg, first_name: 'Анна' });
  const petya = (): TgUser => ({ id: petyaTg, first_name: 'Петя' });
  const blobs: Record<string, Buffer> = { 'tg-pdf': PDF, 'tg-jpg': JPG, 'tg-exe': EXE };
  let updateId = 910_000;
  const media = (user: TgUser, body: Record<string, unknown>) => ({
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      chat: { id: user.id, type: 'private' as const, first_name: user.first_name },
      from: { id: user.id, is_bot: false, first_name: user.first_name },
      ...body,
    },
  });
  const doc = (fileId: string, name: string, size: number) => ({
    document: {
      file_id: fileId,
      file_unique_id: `u-${fileId}-${updateId}`,
      file_name: name,
      file_size: size,
    },
  });
  const sentOf = (type: string) => tdb.db.select().from(notification).where(eq(notification.typeCode, type));

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
        BotApiModule,
        NotificationsModule,
        TelegramModule,
      ],
      { now: '2026-11-02T08:00:00Z' },
    );
    ctx.get(TelegramFileDownloader).transport = async (_api, fileId) => blobs[fileId]!;
    staff = createBotHarness(ctx.get(StaffBot), ctx.get(ActorResolver));
    student = createBotHarness(ctx.get(StudentBot), ctx.get(ActorResolver));
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
    petyaId = (
      await createAccount(tdb.txm, {
        telegramUserId: petyaTg,
        roles: ['STUDENT'],
        firstName: 'Петя',
        lastName: 'Иванов',
        timezone: 'Europe/Minsk',
      })
    ).id;
    await linkStudent(ctx, teacherId, petyaId);
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('assign → notify → submit (photo hint, bad type, two files + text) → queue → return → resubmit → accept', async () => {
    // UC-26: the teacher creates the assignment
    await staff.text(teacher(), '/menu');
    await staff.press(teacher(), '📝 Задания');
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('Заданий пока нет');
    await staff.press(teacher(), '➕ Новое задание');
    await staff.text(teacher(), 'Квадратные уравнения');
    await staff.text(teacher(), 'Решить №1–5');
    await staff.press(teacher(), /Петя/);
    await staff.press(teacher(), /Далее/);
    await staff.text(teacher(), '05.11.2026 18:00');
    await staff.press(teacher(), '📎 Файлы и/или текст');
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('Кому: Петя');
    await staff.press(teacher(), '📣 Опубликовать');
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('опубликовано: адресатов 1');
    await drainOutbox(ctx, tdb);
    const assigned = await sentOf('homework.assigned');
    expect(assigned.map((n) => n.recipientId)).toEqual([petyaId]);
    expect(assigned[0]!.payload).toMatchObject({ due: 'чт 05.11 18:00' });

    // UC-27: the student submits
    await student.text(petya(), '/menu');
    await student.press(petya(), '📝 Задания');
    expect(student.tg.sentTexts(petyaTg).at(-1)).toContain('Квадратные уравнения');
    await student.press(petya(), /Квадратные/);
    expect(student.tg.sentTexts(petyaTg).at(-1)).toContain('Решить №1–5');
    await student.press(petya(), '📤 Сдать');
    await student.handle(
      media(petya(), {
        photo: [{ file_id: 'tg-jpg', file_unique_id: 'u-jpg', width: 10, height: 10, file_size: JPG.length }],
        media_group_id: 'alb1',
      }),
    );
    expect(student.tg.sentTexts(petyaTg).some((t) => t.includes('сжимает фото'))).toBe(true); // HW-03
    await student.handle(media(petya(), doc('tg-exe', 'virus.pdf', EXE.length)));
    expect(student.tg.sentTexts(petyaTg).at(-1)).toContain('не принимается');
    await student.handle(media(petya(), doc('tg-pdf', 'Решение.pdf', PDF.length)));
    await student.text(petya(), 'Ответ: x = 2 и x = 3');
    expect(student.tg.sentTexts(petyaTg).at(-1)).toContain('файлов 2, текстов 1');
    await student.press(petya(), 'Готово');
    await student.press(petya(), '📤 Отправить');
    expect(student.tg.sentTexts(petyaTg).at(-1)).toContain('Работа отправлена');
    await drainOutbox(ctx, tdb);
    expect((await sentOf('submission.received')).length).toBe(1);

    // UC-28: the queue, the card with the album, «На доработку» with a comment
    await staff.text(teacher(), '/menu');
    await staff.press(teacher(), '📝 Задания');
    await staff.press(teacher(), /На проверке \(1\)/);
    await staff.press(teacher(), /Петя/);
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('x = 2 и x = 3');
    expect(staff.tg.calls.filter((c) => c.method === 'sendMediaGroup').length).toBe(1); // two files → one album
    await staff.press(teacher(), '🔁 На доработку');
    await staff.text(teacher(), 'Проверьте знак во втором корне');
    await staff.press(teacher(), /Пропустить/);
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('возвращена на доработку');
    await drainOutbox(ctx, tdb);
    const reviewed = await sentOf('submission.reviewed');
    expect(reviewed.map((n) => (n.payload as { decision: string }).decision)).toEqual(['returned']);

    // the student sees the verdict and resubmits text only; the teacher accepts with a checked file
    await student.text(petya(), '/menu');
    await student.press(petya(), '📝 Задания');
    await student.press(petya(), /Квадратные/);
    expect(student.tg.sentTexts(petyaTg).at(-1)).toContain('Проверьте знак');
    await student.press(petya(), '📤 Сдать');
    await student.text(petya(), 'Исправил: x = -3');
    await student.press(petya(), 'Готово');
    await student.press(petya(), '📤 Отправить');
    await drainOutbox(ctx, tdb);
    await staff.text(teacher(), '/menu');
    await staff.press(teacher(), '📝 Задания');
    await staff.press(teacher(), /На проверке \(1\)/);
    await staff.press(teacher(), /Петя/);
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('попытка 2');
    await staff.press(teacher(), '✅ Принять');
    await staff.press(teacher(), /Пропустить/);
    await staff.handle(media(teacher(), doc('tg-pdf', 'Проверено.pdf', PDF.length)));
    await staff.press(teacher(), 'Готово');
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('принята');
    await student.text(petya(), '/menu');
    await student.press(petya(), '📝 Задания');
    expect(student.tg.sentTexts(petyaTg).at(-1)).toContain('Активных заданий нет');
    await student.press(petya(), '🗂 Завершённые');
    await student.press(petya(), /Квадратные/);
    expect(student.tg.sentTexts(petyaTg).at(-1)).toContain('принято');
    await student.press(petya(), /Файлы учителя/);
    expect(student.tg.sentDocuments(petyaTg).length).toBeGreaterThan(0);
  });
});
