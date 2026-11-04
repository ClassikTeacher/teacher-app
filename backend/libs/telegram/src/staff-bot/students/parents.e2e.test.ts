import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '@test/app.js';
import { createBotHarness, type BotHarness } from '@test/bot.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { drainOutbox } from '@test/outbox.js';
import { createAccount, nextTelegramUserId } from '@test/factories.js';
import { linkStudent } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { notification } from '@modules/notifications/schema.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { ParentBot } from '../../parent-bot/parent-bot.js';
import { StudentBot } from '../../student-bot/student-bot.js';
import { TelegramModule } from '../../telegram.module.js';
import { StaffBot } from '../staff-bot.js';

describe('UC-11: teacher invites a parent from the student card; parent accepts in ParentBot', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let staff: BotHarness;
  let parentBot: BotHarness;
  let studentBot: BotHarness;
  let teacherId: string;
  let studentId: string;
  let studentTg: number;
  const teacherTg = nextTelegramUserId();
  const teacher = () => ({ id: teacherTg, first_name: 'Анна' });
  const linkOf = (text: string): string =>
    /https:\/\/t\.me\/TestParentBot\?start=([A-Za-z0-9_-]{43})/.exec(text)![1]!;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [PeopleModule, AccessModule, NotificationsModule, TelegramModule]);
    staff = createBotHarness(ctx.get(StaffBot), ctx.get(ActorResolver));
    parentBot = createBotHarness(ctx.get(ParentBot), ctx.get(ActorResolver));
    studentBot = createBotHarness(ctx.get(StudentBot), ctx.get(ActorResolver));
    teacherId = (
      await createAccount(tdb.txm, {
        telegramUserId: teacherTg,
        roles: ['TEACHER'],
        firstName: 'Анна',
        lastName: 'Петровна',
      })
    ).id;
    const student = await createAccount(tdb.txm, {
      roles: ['STUDENT'],
      firstName: 'Петя',
      lastName: 'Иванов',
    });
    studentId = student.id;
    studentTg = student.telegramUserId;
    await linkStudent(ctx, teacherId, studentId);
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  const deliverEvents = (): Promise<number> => drainOutbox(ctx, tdb);

  it('card → Родители → link → parent accepts → student and teacher notified → teacher revokes', async () => {
    await staff.text(teacher(), '/menu');
    await staff.press(teacher(), '👥 Ученики');
    await staff.press(teacher(), 'Петя Иванов');
    await staff.press(teacher(), '👨‍👩‍👧 Родители');
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('Родителей пока нет');
    await staff.press(teacher(), '👨‍👩‍👧 Пригласить родителя');
    const card = staff.tg.sentTexts(teacherTg).at(-1)!;
    expect(card).toContain('Приглашение для родителя');
    expect(card).toContain('Ученик: Петя Иванов');
    const token = linkOf(card);
    await staff.press(teacher(), '◀️ Назад');
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('ссылка для родителя ждёт принятия');

    const mom = { id: nextTelegramUserId(), first_name: 'Мария', last_name: 'Иванова' };
    await parentBot.text(mom, `/start ${token}`);
    await parentBot.press(mom, '✅ Да, я родитель');
    await parentBot.press(mom, /Оставить/);
    await parentBot.press(mom, 'Europe/Minsk');
    await parentBot.press(mom, 'Принимаю');
    expect(parentBot.tg.sentTexts(mom.id).at(-1)).toContain('Вы привязаны к ученику Петя Иванов');

    await deliverEvents();
    const rows = await tdb.db
      .select()
      .from(notification)
      .where(eq(notification.typeCode, 'family.parent_linked'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipientId: studentId, bot: 'student' });
    expect(rows[0]!.payload).toMatchObject({ parent: 'Мария Иванова' });
    const teacherRows = await tdb.db
      .select()
      .from(notification)
      .where(eq(notification.typeCode, 'family.parent_connected'));
    expect(teacherRows[0]).toMatchObject({ recipientId: teacherId, bot: 'staff' });

    // the student sees the parent but cannot manage them (3.5)
    await studentBot.text({ id: studentTg, first_name: 'Петя' }, '/menu');
    await studentBot.press({ id: studentTg, first_name: 'Петя' }, '👨‍👩‍👧 Родители');
    const studentView = studentBot.tg.sentTexts(studentTg).at(-1)!;
    expect(studentView).toContain('Мария Иванова');
    expect(studentView).toContain('приглашает и отвязывает учитель');
    expect(
      studentBot.tg
        .lastKeyboard(studentTg)
        .flat()
        .map((b) => b.text),
    ).toEqual(['◀️ Назад']);

    // the parent sees the teacher of the child
    await parentBot.text(mom, '/menu');
    await parentBot.press(mom, '👩‍🏫 Учителя ребёнка');
    await parentBot.press(mom, 'Анна Петровна');
    expect(parentBot.tg.sentTexts(mom.id).at(-1)).toContain('Математика');

    // the inviting teacher revokes the link
    await staff.text(teacher(), '/menu');
    await staff.press(teacher(), '👥 Ученики');
    await staff.press(teacher(), 'Петя Иванов');
    await staff.press(teacher(), '👨‍👩‍👧 Родители');
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('Мария Иванова');
    await staff.press(teacher(), /Отвязать: Мария Иванова/);
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('Отвязать родителя Мария Иванова');
    const confirm = staff.tg.findButton('Да, отвязаться', teacherTg)!.callback_data!;
    await staff.press(teacher(), 'Да, отвязаться');
    expect(await ctx.get(FamilyLinkRepository).listActiveByStudent(studentId)).toHaveLength(0);
    expect(staff.tg.sentTexts(teacherTg).at(-1)).toContain('Родители ученика'); // back on the parents screen
    // a stale second tap is answered, not thrown
    await staff.callback(teacher(), confirm);
    const lastAnswer = staff.tg.calls.filter((c) => c.method === 'answerCallbackQuery').at(-1);
    expect(lastAnswer?.payload['text']).toContain('уже отозвана');
    await deliverEvents();
    const unlinked = await tdb.db
      .select()
      .from(notification)
      .where(eq(notification.typeCode, 'family.parent_unlinked'));
    // the teacher revoked it: the student and the parent are told, the teacher is not
    expect(unlinked.map((n) => n.bot).sort()).toEqual(['parent', 'student']);
    expect(unlinked.find((n) => n.bot === 'parent')!.payload).toMatchObject({
      view: 'parent',
      byText: 'по решению учителя',
    });
  });

  it('a parent unlinks themselves; another teacher sees the parent but cannot revoke', async () => {
    const dad = await createAccount(tdb.txm, { roles: ['PARENT'], firstName: 'Олег', lastName: 'Иванов' });
    await staff.text(teacher(), '/menu');
    await staff.press(teacher(), '👥 Ученики');
    await staff.press(teacher(), 'Петя Иванов');
    await staff.press(teacher(), '👨‍👩‍👧 Родители');
    await staff.press(teacher(), '👨‍👩‍👧 Пригласить родителя');
    const token = linkOf(staff.tg.sentTexts(teacherTg).at(-1)!);
    const user = { id: dad.telegramUserId, first_name: 'Олег' };
    await parentBot.text(user, `/start ${token}`);
    await parentBot.press(user, '✅ Да, я родитель');

    const other = await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Нина' });
    await linkStudent(ctx, other.id, studentId);
    const otherUser = { id: other.telegramUserId, first_name: 'Нина' };
    await staff.text(otherUser, '/menu');
    await staff.press(otherUser, '👥 Ученики');
    await staff.press(otherUser, 'Петя Иванов');
    await staff.press(otherUser, '👨‍👩‍👧 Родители');
    const view = staff.tg.sentTexts(other.telegramUserId).at(-1)!;
    expect(view).toContain('Олег Иванов');
    expect(view).toContain('приглашён другим учителем');
    expect(staff.tg.findButton(/Отвязать/, other.telegramUserId)).toBeUndefined();

    // a crafted link id of another child is not shown to this parent (8.0)
    const foreignStudent = await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Чужой' });
    const foreignLink = await linkStudent(ctx, teacherId, foreignStudent.id);
    await parentBot.text(user, '/menu');
    await parentBot.press(user, '👩‍🏫 Учителя ребёнка');
    await parentBot.callback(user, `s:teachers:card:${foreignLink.id}`);
    expect(parentBot.tg.sentTexts(user.id).at(-1)).toContain('Учителя: Петя Иванов'); // list, not the foreign card

    await parentBot.text(user, '/menu');
    await parentBot.press(user, '👧 Дети');
    await parentBot.press(user, '🔗✖️ Отвязаться от ребёнка');
    expect(parentBot.tg.sentTexts(user.id).at(-1)).toContain('Отвязаться от ученика Петя Иванов?');
    await parentBot.press(user, 'Да, отвязаться');
    expect(parentBot.tg.sentTexts(user.id).at(-1)).toContain('Пока нет привязанных детей');
    expect(await ctx.get(FamilyLinkRepository).listActiveByStudent(studentId)).toHaveLength(0);
  });
});
