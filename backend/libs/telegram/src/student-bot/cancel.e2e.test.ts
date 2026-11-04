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
import { MessageTemplateRepository } from '@modules/people/message-template.repository.js';
import { CreateLessonUseCase } from '@modules/schedule/lessons/create-lesson.use-case.js';
import { LessonRepository } from '@modules/schedule/lessons/lesson.repository.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { BotApiModule } from '@telegram/api/bot-api.module.js';
import { ParentBot } from '../parent-bot/parent-bot.js';
import { TelegramModule } from '../telegram.module.js';
import { StudentBot } from './student-bot.js';

const asActor = (id: string, role: 'TEACHER' | 'STUDENT'): Actor => ({
  accountId: id,
  roles: [role],
  status: 'active',
  source: 'bot',
});

describe('UC-20 / UC-21 in StudentBot and ParentBot (M4-01)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let student: BotHarness;
  let parent: BotHarness;
  let create: CreateLessonUseCase;
  let lessons: LessonRepository;
  const stTg = nextTelegramUserId();
  const paTg = nextTelegramUserId();
  const petya = () => ({ id: stTg, first_name: 'Петя' });
  const mama = () => ({ id: paTg, first_name: 'Мария' });
  let teacher: Actor;
  let teacherId: string;
  let petyaId: string;
  let groupId: string;

  const notes = (recipientId: string, type: string) =>
    tdb.db
      .select()
      .from(notification)
      .where(and(eq(notification.recipientId, recipientId), eq(notification.typeCode, type)));
  const lastText = (h: BotHarness, id: number) => h.tg.sentTexts(id).at(-1)!;

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
    create = ctx.get(CreateLessonUseCase);
    lessons = ctx.get(LessonRepository);
    const t = await createAccount(tdb.txm, {
      roles: ['TEACHER'],
      firstName: 'Анна',
      lastName: 'П',
      username: 'anna_teaches',
      timezone: 'Europe/Minsk',
    });
    teacherId = t.id;
    teacher = asActor(t.id, 'TEACHER');
    await ctx.get(TeacherProfileRepository).upsert(t.id, {
      subjectIds: [MATH_ID],
      onboardedAt: ctx.clock.now(),
      lateCancelHours: 24,
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
      invitedBy: t.id,
      invitationId: null,
      confirmedAt: ctx.clock.now(),
    });
    await linkStudent(ctx, t.id, st.id, { maxLessonsPerWeek: null });
    const masha = await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Маша', lastName: 'С' });
    await linkStudent(ctx, t.id, masha.id, { maxLessonsPerWeek: null });
    const groups = ctx.get(GroupsUseCase);
    groupId = (await groups.create(teacher, { name: '10А', subjectId: MATH_ID })).id;
    await groups.addMember(teacher, groupId, st.id);
    await groups.addMember(teacher, groupId, masha.id);
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('UC-20: card → «Отменить» → starter template → confirmation with the late mark → cancelled; the teacher is told', async () => {
    ctx.clock.set('2026-10-19T12:00:00Z');
    const { lesson } = await create.execute(teacher, {
      target: { studentId: petyaId },
      startsAt: new Date('2026-10-20T09:00:00Z'), // 21 h ahead: late
      durationMin: 60,
    });
    await student.text(petya(), '/menu');
    await student.press(petya(), '📅 Расписание');
    await student.press(petya(), /вт 20.10 12:00/);
    await student.press(petya(), '❌ Отменить');
    expect(lastText(student, stTg)).toContain('Отмена занятия');
    expect(student.tg.findButton('Заболел(а)', stTg)).toBeDefined();
    await student.press(petya(), 'Заболел(а)');
    const confirm = lastText(student, stTg);
    expect(confirm).toContain('Отменить занятие?');
    expect(confirm).toContain('Причина: <i>Заболел(а)</i>');
    expect(confirm).toContain('Поздняя отмена: до начала меньше 24 ч');
    await student.press(petya(), '✅ Подтвердить');
    expect(lastText(student, stTg)).toContain('отменено');
    expect((await lessons.findById(lesson.id))!.status).toBe('cancelled');
    await drainOutbox(ctx, tdb);
    const toTeacher = await notes(teacherId, 'lesson.cancelled');
    expect(toTeacher).toHaveLength(1);
    expect(toTeacher[0]!.payload).toMatchObject({
      view: 'by-student',
      by: 'Петя Иванов',
      message: 'Заболел(а)',
    });
    await student.press(petya(), '◀️ К занятию');
    expect(lastText(student, stTg)).toContain('отменено');
    expect(student.tg.findButton('❌ Отменить', stTg)).toBeUndefined();
  });

  it('own text, cancel of the dialog, and the reminder button start the same dialog', async () => {
    const { lesson } = await create.execute(teacher, {
      target: { studentId: petyaId },
      startsAt: new Date('2026-10-23T09:00:00Z'),
      durationMin: 60,
    });
    await drainOutbox(ctx, tdb); // reminders planned with the «Отменить» button
    const reminder = (await notes(petyaId, 'lesson.reminder')).find((n) => n.dedupeKey.includes(lesson.id))!;
    const buttons = reminder.payload['buttons'] as Array<{ text: string; data: string }>;
    expect(buttons).toEqual([
      { text: '❌ Отменить', data: `s:schedule:cancel:${lesson.id}` },
      { text: '🔁 Перенести', data: `s:schedule:move:${lesson.id}` },
    ]);
    await student.callback(petya(), buttons[0]!.data);
    expect(lastText(student, stTg)).toContain('Отмена занятия');
    await student.press(petya(), 'Отмена');
    expect(lastText(student, stTg)).toContain('Диалог прерван');
    expect((await lessons.findById(lesson.id))!.status).toBe('scheduled');
    await student.callback(petya(), buttons[0]!.data);
    await student.press(petya(), '✍️ Свой текст');
    await student.text(petya(), '   ');
    expect(lastText(student, stTg)).toContain('не длиннее');
    await student.text(petya(), 'Уезжаем к бабушке');
    expect(lastText(student, stTg)).toContain('Причина: <i>Уезжаем к бабушке</i>');
    expect(lastText(student, stTg)).not.toContain('Поздняя отмена');
    await student.press(petya(), '✅ Подтвердить');
    expect((await lessons.findById(lesson.id))!.status).toBe('cancelled');
  });

  it('UC-20 alternatives: cancelling switched off, cutoff, a started lesson — explained with «Написать учителю»', async () => {
    const profiles = ctx.get(TeacherProfileRepository);
    const { lesson } = await create.execute(teacher, {
      target: { studentId: petyaId },
      startsAt: new Date('2026-10-24T09:00:00Z'),
      durationMin: 60,
    });
    await profiles.upsert(teacherId, { studentCanCancel: false });
    await student.callback(petya(), `s:schedule:cancel:${lesson.id}`);
    expect(lastText(student, stTg)).toContain(
      'Учитель отключил отмену занятий через бота. Напишите учителю напрямую.',
    );
    expect(student.tg.findButton('✉️ Написать учителю', stTg)).toBeDefined();
    await profiles.upsert(teacherId, { studentCanCancel: true, studentCancelCutoffHours: 240 });
    await student.callback(petya(), `s:schedule:cancel:${lesson.id}`);
    expect(lastText(student, stTg)).toContain('Отменить можно не позже чем за 240 ч до начала.');
    await profiles.upsert(teacherId, { studentCancelCutoffHours: null });
    ctx.clock.set('2026-10-24T09:05:00Z');
    await student.callback(petya(), `s:schedule:cancel:${lesson.id}`);
    expect(lastText(student, stTg)).toContain('Занятие уже идёт. Напишите учителю напрямую.');
    ctx.clock.set('2026-10-19T12:00:00Z');
    // the rules change between the confirmation and the press: explained, the dialog is dropped
    await student.callback(petya(), `s:schedule:cancel:${lesson.id}`);
    await student.press(petya(), 'Заболел(а)');
    await profiles.upsert(teacherId, { studentCanCancel: false });
    await student.press(petya(), '✅ Подтвердить');
    expect(lastText(student, stTg)).toContain('Учитель отключил отмену');
    await profiles.upsert(teacherId, { studentCanCancel: true });
    expect((await lessons.findById(lesson.id))!.status).toBe('scheduled');
  });

  it('UC-21: a group lesson → «Не смогу прийти» → absence notice; the teacher is told, the lesson stays', async () => {
    const { lesson } = await create.execute(teacher, {
      target: { groupId },
      startsAt: new Date('2026-10-25T09:00:00Z'),
      durationMin: 60,
    });
    await student.text(petya(), '/menu');
    await student.press(petya(), '📅 Расписание');
    await student.press(petya(), /вс 25.10 12:00/);
    expect(student.tg.findButton('🙋 Не смогу прийти', stTg)).toBeDefined();
    await student.press(petya(), '🙋 Не смогу прийти');
    expect(lastText(student, stTg)).toContain('Отсутствие на групповом занятии');
    await student.press(petya(), 'Контрольная или мероприятие в школе');
    expect(lastText(student, stTg)).toContain('Сообщить об отсутствии?');
    await student.press(petya(), '✅ Подтвердить');
    expect(lastText(student, stTg)).toContain('Учитель предупреждён');
    expect((await lessons.findById(lesson.id))!.status).toBe('scheduled');
    await drainOutbox(ctx, tdb);
    const toTeacher = await notes(teacherId, 'lesson.absence');
    expect(toTeacher).toHaveLength(1);
    expect(toTeacher[0]!.payload).toMatchObject({ view: 'by-student', student: 'Петя Иванов' });
    // twice: already reported
    await student.callback(petya(), `s:schedule:cancel:${lesson.id}`);
    expect(lastText(student, stTg)).toContain('Занятие уже отменено или завершено');
  });

  it('the parent cancels the child’s lesson from ParentBot with an own template; the teacher and the child are told', async () => {
    const { lesson } = await create.execute(teacher, {
      target: { studentId: petyaId },
      startsAt: new Date('2026-10-26T09:00:00Z'),
      durationMin: 60,
    });
    const parentId = (await ctx.get(ActorResolver).byTelegramUserId(paTg, 'bot'))!.account.id;
    await ctx
      .get(MessageTemplateRepository)
      .insert({ ownerId: parentId, kind: 'cancel_reason', text: 'Едем к врачу', position: 0 });
    await parent.text(mama(), '/menu');
    await parent.press(mama(), '📅 Расписание ребёнка');
    await parent.press(mama(), /пн 26.10 12:00/);
    await parent.press(mama(), '❌ Отменить');
    expect(parent.tg.findButton('Едем к врачу', paTg)).toBeDefined();
    expect(parent.tg.findButton('Заболел(а)', paTg)).toBeUndefined(); // own templates replace the starter set
    await parent.press(mama(), 'Едем к врачу');
    await parent.press(mama(), '✅ Подтвердить');
    expect(lastText(parent, paTg)).toContain('отменено');
    expect((await lessons.findById(lesson.id))!.status).toBe('cancelled');
    await drainOutbox(ctx, tdb);
    const toTeacher = (await notes(teacherId, 'lesson.cancelled')).filter((n) =>
      n.dedupeKey.includes(lesson.id),
    );
    expect(toTeacher[0]!.payload).toMatchObject({
      view: 'by-parent',
      by: 'Мария Иванова',
      child: 'Петя Иванов',
    });
    const toPetya = (await notes(petyaId, 'lesson.cancelled')).filter((n) => n.dedupeKey.includes(lesson.id));
    expect(toPetya[0]!.payload).toMatchObject({ view: 'to-student', message: 'Едем к врачу' });
  });
});
