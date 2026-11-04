import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
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
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { GroupsUseCase } from '@modules/people/groups/groups.use-case.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { CreateLessonUseCase } from '@modules/schedule/lessons/create-lesson.use-case.js';
import { LessonRepository } from '@modules/schedule/lessons/lesson.repository.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { BotApiModule } from '@telegram/api/bot-api.module.js';
import { ParentBot } from '../parent-bot/parent-bot.js';
import { TelegramModule } from '../telegram.module.js';
import { StudentBot } from './student-bot.js';

const asTeacher = (id: string): Actor => ({
  accountId: id,
  roles: ['TEACHER'],
  status: 'active',
  source: 'bot',
});

describe('UC-23: bulk cancellation in StudentBot and ParentBot (M4-02)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let student: BotHarness;
  let parent: BotHarness;
  let annaId: string;
  let olegId: string;
  let petyaId: string;
  let groupId: string;
  const stTg = nextTelegramUserId();
  const paTg = nextTelegramUserId();
  const petya = () => ({ id: stTg, first_name: 'Петя' });
  const mama = () => ({ id: paTg, first_name: 'Мария' });
  const lastText = (h: BotHarness, id: number) => h.tg.sentTexts(id).at(-1)!;
  const notes = (recipientId: string, type: string) =>
    tdb.db
      .select()
      .from(notification)
      .where(and(eq(notification.recipientId, recipientId), eq(notification.typeCode, type)));

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
    student = createBotHarness(ctx.get(StudentBot), ctx.get(ActorResolver));
    parent = createBotHarness(ctx.get(ParentBot), ctx.get(ActorResolver));
    const profiles = ctx.get(TeacherProfileRepository);
    annaId = (
      await createAccount(tdb.txm, {
        roles: ['TEACHER'],
        firstName: 'Анна',
        lastName: 'П',
        timezone: 'Europe/Minsk',
      })
    ).id;
    olegId = (
      await createAccount(tdb.txm, {
        roles: ['TEACHER'],
        firstName: 'Олег',
        lastName: 'Б',
        timezone: 'Europe/Minsk',
      })
    ).id;
    await profiles.upsert(annaId, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now() });
    await profiles.upsert(olegId, {
      subjectIds: [MATH_ID],
      onboardedAt: ctx.clock.now(),
      studentCancelCutoffHours: 240,
    });
    const st = await createAccount(tdb.txm, {
      telegramUserId: stTg,
      roles: ['STUDENT'],
      firstName: 'Петя',
      lastName: 'Иванов',
      timezone: 'Europe/Minsk',
    });
    petyaId = st.id;
    const pa = await createAccount(tdb.txm, {
      telegramUserId: paTg,
      roles: ['PARENT'],
      firstName: 'Мария',
      lastName: 'Иванова',
      timezone: 'Europe/Minsk',
    });
    await ctx.get(FamilyLinkRepository).insert({
      parentId: pa.id,
      studentId: st.id,
      invitedBy: annaId,
      invitationId: null,
      confirmedAt: ctx.clock.now(),
    });
    const masha = await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Маша', lastName: 'С' });
    for (const t of [annaId, olegId]) {
      await linkStudent(ctx, t, st.id, { maxLessonsPerWeek: null });
      await linkStudent(ctx, t, masha.id, { maxLessonsPerWeek: null });
    }
    const groups = ctx.get(GroupsUseCase);
    groupId = (await groups.create(asTeacher(annaId), { name: '10А', subjectId: MATH_ID })).id;
    await groups.addMember(asTeacher(annaId), groupId, st.id);
    await groups.addMember(asTeacher(annaId), groupId, masha.id);
    const create = ctx.get(CreateLessonUseCase);
    await create.execute(asTeacher(annaId), {
      target: { studentId: st.id },
      startsAt: new Date('2026-10-20T13:00:00Z'),
      durationMin: 60,
    });
    await create.execute(asTeacher(annaId), {
      target: { groupId },
      startsAt: new Date('2026-10-21T13:00:00Z'),
      durationMin: 60,
    });
    await create.execute(asTeacher(olegId), {
      target: { studentId: st.id },
      startsAt: new Date('2026-10-22T13:00:00Z'),
      durationMin: 60,
    });
    await create.execute(asTeacher(annaId), {
      target: { studentId: st.id },
      startsAt: new Date('2026-10-28T13:00:00Z'),
      durationMin: 60,
    });
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('«Отменить занятие» → period «7 дней»: group → absence, Oleg’s lesson excluded by the cutoff, one summary to Anna', async () => {
    await student.text(petya(), '/menu');
    await student.press(petya(), '❌ Отменить занятие');
    expect(lastText(student, stTg)).toContain('Что отменяем?');
    await student.press(petya(), '📆 За период');
    await student.press(petya(), '7 дней');
    const preview = lastText(student, stTg);
    expect(preview).toContain('2 занятия');
    expect(preview).toContain('вт 20.10 16:00 Анна П');
    expect(preview).toContain('🙋 ср 21.10 16:00 Анна П');
    expect(preview).toContain('Исключены (отменить нельзя): чт 22.10 16:00 Олег Б — поздно отменять');
    await student.press(petya(), 'Далее ➡️');
    expect(lastText(student, stTg)).toContain('Групповые занятия станут сообщениями об отсутствии');
    await student.press(petya(), 'Заболел(а)');
    expect(lastText(student, stTg)).toContain('Отменить 2 занятия?');
    await student.press(petya(), '✅ Отменить (2)');
    expect(lastText(student, stTg)).toContain('Отменено: 2');
    await drainOutbox(ctx, tdb);
    const anna = await notes(annaId, 'cancellation.bulk');
    expect(anna).toHaveLength(1);
    expect(anna[0]!.payload).toMatchObject({
      view: 'by-student',
      cancelledCount: 1,
      absenceCount: 1,
      message: 'Заболел(а)',
    });
    expect(await notes(olegId, 'cancellation.bulk')).toHaveLength(0);
  });

  it('«Выбрать из списка» and «У одного учителя за период» from StudentBot; nothing left → explained', async () => {
    await student.text(petya(), '/menu');
    await student.press(petya(), '❌ Отменить занятие');
    await student.press(petya(), '☑️ Выбрать из списка');
    expect(student.tg.findButton(/⬜ ср 28.10 16:00 Анна П/, stTg)).toBeDefined();
    expect(student.tg.findButton(/вт 20.10/, stTg)).toBeUndefined(); // cancelled lessons are not listed
    await student.press(petya(), 'Отмена');
    await student.text(petya(), '/menu');
    await student.press(petya(), '❌ Отменить занятие');
    await student.press(petya(), '👩‍🏫 У одного учителя за период');
    expect(lastText(student, stTg)).toContain('У какого учителя?');
    await student.press(petya(), 'Олег Б');
    await student.press(petya(), '14 дней');
    expect(lastText(student, stTg)).toContain('Исключены');
    expect(student.tg.findButton('Далее ➡️', stTg)).toBeUndefined(); // nothing cancellable → no way forward
  });

  it('the parent cancels the child’s lessons for a period from ParentBot', async () => {
    await parent.text(mama(), '/menu');
    await parent.press(mama(), '📅 Расписание ребёнка');
    await parent.press(mama(), '❌ Отменить несколько');
    await parent.press(mama(), '📆 За период');
    await parent.press(mama(), 'Ввести даты');
    await parent.text(mama(), '28.10');
    expect(lastText(parent, paTg)).toContain('1 занятие');
    await parent.press(mama(), 'Далее ➡️');
    await parent.press(mama(), 'Семейные обстоятельства');
    await parent.press(mama(), '✅ Отменить (1)');
    expect(lastText(parent, paTg)).toContain('Отменено: 1');
    const week = await ctx.get(LessonRepository).listByStudent(petyaId, {
      start: new Date('2026-10-28T00:00:00Z'),
      end: new Date('2026-10-29T00:00:00Z'),
    });
    expect(week.map((l) => l.status)).toEqual(['cancelled']);
    await drainOutbox(ctx, tdb);
    const anna = (await notes(annaId, 'cancellation.bulk')).filter(
      (n) => String(n.payload['view']) === 'by-parent',
    );
    expect(anna).toHaveLength(1);
    expect(anna[0]!.payload).toMatchObject({ child: 'Петя Иванов', cancelledCount: 1 });
    expect((await notes(petyaId, 'cancellation.bulk')).some((n) => n.payload['view'] === 'to-student')).toBe(
      true,
    );
  });
});
