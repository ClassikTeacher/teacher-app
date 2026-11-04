import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@test/app.js';
import { createBotHarness, type BotHarness } from '@test/bot.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount, nextTelegramUserId } from '@test/factories.js';
import { linkStudent, MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import type { Actor } from '@modules/access/actor.js';
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { EndLinkUseCase } from '@modules/people/links/end-link.use-case.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { CreateLessonUseCase } from '@modules/schedule/lessons/create-lesson.use-case.js';
import { LessonReportUseCase } from '@modules/schedule/lessons/lesson-report.use-case.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { ParentBot } from '../parent-bot/parent-bot.js';
import { TelegramModule } from '../telegram.module.js';
import { StudentBot } from './student-bot.js';

const asTeacher = (id: string): Actor => ({
  accountId: id,
  roles: ['TEACHER'],
  status: 'active',
  source: 'bot',
});

describe('M3-06: schedule in StudentBot and ParentBot (5.5.3, own zone)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let student: BotHarness;
  let parent: BotHarness;
  const stTg = nextTelegramUserId();
  const paTg = nextTelegramUserId();
  const petya = () => ({ id: stTg, first_name: 'Петя' });
  const mama = () => ({ id: paTg, first_name: 'Мария' });
  let teacherA: Actor;
  let teacherB: Actor;
  let studentId: string;
  let linkBId: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [PeopleModule, AccessModule, ScheduleModule, TelegramModule]);
    student = createBotHarness(ctx.get(StudentBot), ctx.get(ActorResolver));
    parent = createBotHarness(ctx.get(ParentBot), ctx.get(ActorResolver));
    const a = await createAccount(tdb.txm, {
      roles: ['TEACHER'],
      firstName: 'Анна',
      lastName: 'П',
      timezone: 'Europe/Minsk',
    });
    const b = await createAccount(tdb.txm, {
      roles: ['TEACHER'],
      firstName: 'Олег',
      lastName: 'Б',
      timezone: 'Europe/Minsk',
    });
    teacherA = asTeacher(a.id);
    teacherB = asTeacher(b.id);
    const profiles = ctx.get(TeacherProfileRepository);
    await profiles.upsert(a.id, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now() });
    await profiles.upsert(b.id, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now() });
    // the student lives in Yekaterinburg (+5), the parent in Minsk (+3)
    const st = await createAccount(tdb.txm, {
      telegramUserId: stTg,
      roles: ['STUDENT'],
      firstName: 'Петя',
      lastName: 'Иванов',
      timezone: 'Asia/Yekaterinburg',
    });
    studentId = st.id;
    const pa = await createAccount(tdb.txm, {
      telegramUserId: paTg,
      roles: ['PARENT'],
      firstName: 'Мария',
      timezone: 'Europe/Minsk',
    });
    await ctx.get(FamilyLinkRepository).insert({
      parentId: pa.id,
      studentId: st.id,
      invitedBy: a.id,
      invitationId: null,
      confirmedAt: ctx.clock.now(),
    });
    await linkStudent(ctx, a.id, st.id);
    linkBId = (await linkStudent(ctx, b.id, st.id)).id;
    const create = ctx.get(CreateLessonUseCase);
    await create.execute(teacherA, {
      target: { studentId: st.id },
      startsAt: new Date('2026-10-20T13:00:00Z'),
      durationMin: 60,
      format: 'online',
      meetingUrl: 'https://meet.example/abc',
    });
    await create.execute(teacherB, {
      target: { studentId: st.id },
      startsAt: new Date('2026-10-21T13:00:00Z'),
      durationMin: 45,
    });
    ctx.clock.set('2026-10-19T08:00:00Z'); // the "past" lesson is created before it starts, then reported after it
    const past = await create.execute(teacherA, {
      target: { studentId: st.id },
      startsAt: new Date('2026-10-19T09:00:00Z'),
      durationMin: 60,
    });
    ctx.clock.set('2026-10-19T12:00:00Z');
    await ctx.get(LessonReportUseCase).complete(teacherA, past.lesson.id, {
      topic: 'Дроби',
      attendance: [{ studentId: st.id, attendance: 'present' }],
      sharedComment: 'Отлично',
    });
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('the student sees both teachers in Yekaterinburg time, the card, the past list; history stays after a link ends', async () => {
    await student.text(petya(), '/menu');
    await student.press(petya(), '📅 Расписание');
    const text = student.tg.sentTexts(stTg).at(-1)!;
    expect(text).toContain('вт 20.10 18:00–19:00 · Анна П · Математика'); // 13:00Z = 18:00 in Yekaterinburg
    expect(text).toContain('ср 21.10 18:00–18:45 · Олег Б');
    await student.press(petya(), /вт 20.10 18:00 Анна П/);
    const card = student.tg.sentTexts(stTg).at(-1)!;
    expect(card).toContain('Занятие №1');
    expect(card).toContain('вторник 20.10 18:00–19:00 (60 мин)');
    expect(card).toContain('Онлайн: https://meet.example/abc');
    expect(student.tg.findButton('❌ Отменить', stTg)).toBeDefined();
    await student.press(petya(), '❌ Отменить'); // UC-20 dialog (M4-01); leaving it returns to the card
    expect(student.tg.sentTexts(stTg).at(-1)).toContain('Отмена занятия');
    await student.press(petya(), 'Отмена');
    await student.press(petya(), '◀️ К занятию');
    await student.press(petya(), '◀️ Назад');
    await student.press(petya(), '🕘 Прошедшие занятия');
    expect(student.tg.sentTexts(stTg).at(-1)).toContain('✅ пн 19.10 14:00–15:00 · Анна П');
    await student.press(petya(), /пн 19.10 14:00 Анна П/);
    expect(student.tg.sentTexts(stTg).at(-1)).toContain('Тема: Дроби');
    expect(student.tg.sentTexts(stTg).at(-1)).toContain('Комментарий: Отлично');

    // a lesson of another student is not reachable by id
    const other = await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Чужой' });
    await linkStudent(ctx, teacherB.accountId, other.id);
    const foreign = await ctx.get(CreateLessonUseCase).execute(teacherB, {
      target: { studentId: other.id },
      startsAt: new Date('2026-10-22T13:00:00Z'),
      durationMin: 60,
    });
    await student.callback(petya(), `s:schedule:lesson:${foreign.lesson.id}`);
    expect(student.tg.sentTexts(stTg).at(-1)).toContain('Расписание');
    expect(student.tg.sentTexts(stTg).at(-1)).not.toContain('22.10');

    // teacher B ends the link: the lesson stays readable as history (8.0 "archive")
    await ctx
      .get(EndLinkUseCase)
      .execute(teacherB, linkBId, { reason: 'removed_by_teacher', message: 'пока' });
    await student.text(petya(), '/menu');
    await student.press(petya(), '📅 Расписание');
    expect(student.tg.sentTexts(stTg).at(-1)).toContain('Олег Б');
    expect(studentId).toBeDefined();
  });

  it('a group lesson card shows no other participants; a blocked child is invisible to the parent', async () => {
    const { GroupsUseCase } = await import('@modules/people/groups/groups.use-case.js');
    const groups = ctx.get(GroupsUseCase);
    const group = await groups.create(teacherA, { name: '10А' });
    const mate = await createAccount(tdb.txm, {
      roles: ['STUDENT'],
      firstName: 'Секретный',
      lastName: 'Одноклассник',
    });
    await linkStudent(ctx, teacherA.accountId, mate.id);
    await groups.addMember(teacherA, group.id, studentId);
    await groups.addMember(teacherA, group.id, mate.id);
    const gl = await ctx.get(CreateLessonUseCase).execute(teacherA, {
      target: { groupId: group.id },
      startsAt: new Date('2026-10-23T13:00:00Z'),
      durationMin: 60,
      teacherNotes: 'приватная заметка',
    });
    await student.callback(petya(), `s:schedule:lesson:${gl.lesson.id}`);
    const card = student.tg.sentTexts(stTg).at(-1)!;
    expect(card).toContain('Занятие');
    expect(card).not.toContain('Секретный');
    expect(card).not.toContain('приватная');
    await student.callback(petya(), 's:schedule:lesson:not-a-uuid');
    expect(student.tg.sentTexts(stTg).at(-1)).toContain('Расписание');

    const { AccountRepository } = await import('@modules/identity/account.repository.js');
    await ctx.get(AccountRepository).update(studentId, { status: 'blocked' });
    await parent.text(mama(), '/menu');
    await parent.press(mama(), '📅 Расписание ребёнка');
    expect(parent.tg.sentTexts(paTg).at(-1)).toContain('занятий нет');
    await parent.callback(mama(), `s:schedule:lesson:${gl.lesson.id}`);
    expect(parent.tg.sentTexts(paTg).at(-1)).not.toContain('Учитель:');
    await ctx.get(AccountRepository).update(studentId, { status: 'active' });
  });

  it('the parent sees the child schedule in Minsk time with stub actions', async () => {
    await parent.text(mama(), '/menu');
    await parent.press(mama(), '📅 Расписание ребёнка');
    const text = parent.tg.sentTexts(paTg).at(-1)!;
    expect(text).toContain('Расписание: Петя Иванов');
    expect(text).toContain('вт 20.10 16:00–17:00 · Анна П'); // 13:00Z = 16:00 in Minsk
    await parent.press(mama(), /вт 20.10 16:00 Анна П/);
    expect(parent.tg.sentTexts(paTg).at(-1)).toContain('Учитель: Анна П');
    expect(parent.tg.findButton('❌ Отменить', paTg)).toBeDefined();
  });
});
