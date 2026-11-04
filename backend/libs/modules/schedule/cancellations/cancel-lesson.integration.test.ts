import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount } from '@test/factories.js';
import { drainOutbox } from '@test/outbox.js';
import { linkStudent, MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import type { Actor } from '@modules/access/actor.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { notification } from '@modules/notifications/schema.js';
import { occupancy } from '../schema.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { MessageTemplateRepository } from '@modules/people/message-template.repository.js';
import { GroupsUseCase } from '@modules/people/groups/groups.use-case.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { BotApiModule } from '@telegram/api/bot-api.module.js';
import { CreateLessonUseCase } from '../lessons/create-lesson.use-case.js';
import { LessonRepository } from '../lessons/lesson.repository.js';
import { ScheduleModule } from '../schedule.module.js';
import { CancelLessonUseCase } from './cancel-lesson.use-case.js';
import { CancellationRepository } from './cancellation.repository.js';

const actor = (id: string, role: 'TEACHER' | 'STUDENT' | 'PARENT'): Actor => ({
  accountId: id,
  roles: [role],
  status: 'active',
  source: 'bot',
});

describe('UC-20 / UC-21: cancelling a lesson and reporting absence (5.7.3, CNL-01…08)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let cancel: CancelLessonUseCase;
  let create: CreateLessonUseCase;
  let lessons: LessonRepository;
  let teacherId: string;
  let petyaId: string;
  let mashaId: string;
  let mamaId: string;
  let groupId: string;

  const notes = (recipientId: string, type: string) =>
    tdb.db
      .select()
      .from(notification)
      .where(and(eq(notification.recipientId, recipientId), eq(notification.typeCode, type)));
  const busyOf = (lessonId: string) =>
    tdb.db.select().from(occupancy).where(eq(occupancy.lessonId, lessonId));
  const individual = (startIso: string) =>
    create.execute(actor(teacherId, 'TEACHER'), {
      target: { studentId: petyaId },
      startsAt: new Date(startIso),
      durationMin: 60,
    });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [
      PeopleModule,
      AccessModule,
      ScheduleModule,
      BotApiModule,
      NotificationsModule,
    ]);
    cancel = ctx.get(CancelLessonUseCase);
    create = ctx.get(CreateLessonUseCase);
    lessons = ctx.get(LessonRepository);
    teacherId = (await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Анна', lastName: 'П' })).id;
    await ctx.get(TeacherProfileRepository).upsert(teacherId, {
      subjectIds: [MATH_ID],
      onboardedAt: ctx.clock.now(),
      defaultNoticeText: 'Вынуждена отменить занятие',
      lateCancelHours: 24,
    });
    petyaId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Петя', lastName: 'И' })).id;
    mashaId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Маша', lastName: 'С' })).id;
    mamaId = (await createAccount(tdb.txm, { roles: ['PARENT'], firstName: 'Мария', lastName: 'И' })).id;
    await linkStudent(ctx, teacherId, petyaId, { maxLessonsPerWeek: null });
    await linkStudent(ctx, teacherId, mashaId, { maxLessonsPerWeek: null });
    await ctx.get(FamilyLinkRepository).insert({
      parentId: mamaId,
      studentId: petyaId,
      invitedBy: teacherId,
      invitationId: null,
      confirmedAt: ctx.clock.now(),
    });
    const groups = ctx.get(GroupsUseCase);
    const t = actor(teacherId, 'TEACHER');
    groupId = (await groups.create(t, { name: '10А', subjectId: MATH_ID })).id;
    await groups.addMember(t, groupId, petyaId);
    await groups.addMember(t, groupId, mashaId);
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('the teacher cancels: status, time freed, record, history, one message to the student, reminders dropped', async () => {
    ctx.clock.set('2026-10-19T12:00:00Z');
    const { lesson } = await individual('2026-10-22T13:00:00Z');
    await drainOutbox(ctx, tdb); // lesson.created → reminders planned
    expect((await notes(petyaId, 'lesson.reminder')).length).toBeGreaterThan(0);
    const result = await cancel.execute(actor(teacherId, 'TEACHER'), {
      lessonId: lesson.id,
      reason: ' Вынуждена отменить занятие ',
    });
    expect(result).toMatchObject({ outcome: 'cancel', isLate: false });
    const fresh = (await lessons.findById(lesson.id))!;
    expect(fresh).toMatchObject({ status: 'cancelled', cancellationId: result.cancellation.id, version: 2 });
    expect(fresh.cancelledAt).toEqual(ctx.clock.now());
    const busy = await busyOf(lesson.id);
    expect(busy.length).toBe(2);
    expect(busy.every((o) => !o.isActive)).toBe(true);
    const items = await ctx.get(CancellationRepository).listItems(result.cancellation.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      lessonId: lesson.id,
      action: 'cancelled',
      isLate: false,
      studentId: null,
    });
    expect(result.cancellation).toMatchObject({
      initiatorRole: 'TEACHER',
      kind: 'single',
      reason: 'Вынуждена отменить занятие',
    });
    expect((await lessons.listEvents(lesson.id)).map((e) => e.type)).toEqual(['created', 'cancelled']);
    await drainOutbox(ctx, tdb);
    const toPetya = await notes(petyaId, 'lesson.cancelled');
    expect(toPetya).toHaveLength(1);
    expect(toPetya[0]!.bot).toBe('student');
    expect(toPetya[0]!.payload).toMatchObject({ view: 'by-teacher', message: 'Вынуждена отменить занятие' });
    expect(await notes(teacherId, 'lesson.cancelled')).toHaveLength(0);
    const reminders = await notes(petyaId, 'lesson.reminder');
    expect(reminders.every((r) => r.status === 'cancelled')).toBe(true); // NTF-05
    await expect(
      cancel.execute(actor(teacherId, 'TEACHER'), { lessonId: lesson.id, reason: 'ещё раз' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('CNL-01: an empty reason is refused before anything changes', async () => {
    const { lesson } = await individual('2026-10-23T13:00:00Z');
    await expect(
      cancel.execute(actor(teacherId, 'TEACHER'), { lessonId: lesson.id, reason: '   ' }),
    ).rejects.toMatchObject({ code: 'CANCEL_REASON_REQUIRED' });
    expect((await lessons.findById(lesson.id))!.status).toBe('scheduled');
  });

  it('the student cancels late → the teacher is told with the late mark; a started lesson only the teacher can cancel', async () => {
    ctx.clock.set('2026-10-19T12:00:00Z');
    const { lesson } = await individual('2026-10-20T09:00:00Z'); // 21 h ahead → late (24 h threshold)
    expect(await cancel.preview(actor(petyaId, 'STUDENT'), lesson.id)).toEqual({
      outcome: 'cancel',
      isLate: true,
    });
    const result = await cancel.execute(actor(petyaId, 'STUDENT'), {
      lessonId: lesson.id,
      reason: 'Заболел',
    });
    expect(result.isLate).toBe(true);
    await drainOutbox(ctx, tdb);
    const toTeacher = await notes(teacherId, 'lesson.cancelled');
    expect(toTeacher).toHaveLength(1);
    expect(toTeacher[0]!.bot).toBe('staff');
    expect(toTeacher[0]!.payload).toMatchObject({
      view: 'by-student',
      by: 'Петя И',
      lateMark: ' ⚠️ Поздняя отмена.',
    });

    const started = await individual('2026-10-19T13:00:00Z');
    ctx.clock.set('2026-10-19T13:10:00Z');
    await expect(
      cancel.execute(actor(petyaId, 'STUDENT'), { lessonId: started.lesson.id, reason: 'x' }),
    ).rejects.toMatchObject({ code: 'LESSON_STARTED' });
    await cancel.execute(actor(teacherId, 'TEACHER'), {
      lessonId: started.lesson.id,
      reason: 'Связь пропала',
    });
    ctx.clock.set('2026-10-19T14:30:00Z');
    const over = await individual('2026-10-19T15:00:00Z');
    ctx.clock.set('2026-10-19T16:01:00Z');
    await expect(
      cancel.execute(actor(teacherId, 'TEACHER'), { lessonId: over.lesson.id, reason: 'поздно' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    ctx.clock.set('2026-10-19T12:00:00Z');
  });

  it('CNL-02 / CNL-07: switches and cutoff for the student and the parent; a foreign lesson is not found', async () => {
    const profiles = ctx.get(TeacherProfileRepository);
    const { lesson } = await individual('2026-10-24T13:00:00Z');
    await profiles.upsert(teacherId, { studentCanCancel: false });
    await expect(cancel.preview(actor(petyaId, 'STUDENT'), lesson.id)).rejects.toMatchObject({
      code: 'CANCEL_DISABLED',
    });
    expect((await cancel.preview(actor(mamaId, 'PARENT'), lesson.id, petyaId)).outcome).toBe('cancel');
    await profiles.upsert(teacherId, { studentCanCancel: true, studentCancelCutoffHours: 48 });
    ctx.clock.set('2026-10-23T12:00:00Z'); // 25 h before: later than the 48 h cutoff
    await expect(cancel.preview(actor(petyaId, 'STUDENT'), lesson.id)).rejects.toMatchObject({
      code: 'CANCEL_CUTOFF',
      details: { cutoffHours: 48 },
    });
    await profiles.upsert(teacherId, { studentCancelCutoffHours: null });
    ctx.clock.set('2026-10-19T12:00:00Z');
    // Masha is not a participant, a stranger parent has no family link
    await expect(cancel.preview(actor(mashaId, 'STUDENT'), lesson.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const stranger = (await createAccount(tdb.txm, { roles: ['PARENT'] })).id;
    await expect(cancel.preview(actor(stranger, 'PARENT'), lesson.id, petyaId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(cancel.preview(actor(mamaId, 'PARENT'), lesson.id, mashaId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('an explicit role is honoured for dual-role accounts; a foreign or archived template is refused', async () => {
    const { lesson } = await individual('2026-10-27T13:00:00Z');
    // Petya also teaches: as TEACHER he is not this lesson's teacher → NOT_FOUND, as STUDENT he may cancel
    const dual: Actor = { ...actor(petyaId, 'STUDENT'), roles: ['STUDENT', 'TEACHER'] };
    await expect(cancel.preview(dual, lesson.id, undefined, 'TEACHER')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await cancel.preview(dual, lesson.id, undefined, 'STUDENT')).outcome).toBe('cancel');
    const foreign = await ctx
      .get(MessageTemplateRepository)
      .insert({ ownerId: mashaId, kind: 'cancel_reason', text: 'чужой', position: 0 });
    await expect(
      cancel.execute(dual, { lessonId: lesson.id, reason: 'чужой', templateId: foreign.id, as: 'STUDENT' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect((await lessons.findById(lesson.id))!.status).toBe('scheduled');
    const own = await ctx
      .get(MessageTemplateRepository)
      .insert({ ownerId: petyaId, kind: 'cancel_reason', text: 'Заболел', position: 0 });
    const result = await cancel.execute(dual, {
      lessonId: lesson.id,
      reason: 'Заболел',
      templateId: own.id,
      as: 'STUDENT',
    });
    expect(result.cancellation.templateId).toBe(own.id);
  });

  it('the parent cancels for the child: the teacher and the student are told, the record names the child', async () => {
    const { lesson } = await individual('2026-10-25T13:00:00Z');
    const result = await cancel.execute(actor(mamaId, 'PARENT'), {
      lessonId: lesson.id,
      reason: 'Семейные обстоятельства',
      studentId: petyaId,
    });
    expect(result.cancellation).toMatchObject({ initiatorRole: 'PARENT', onBehalfOfStudentId: petyaId });
    await drainOutbox(ctx, tdb);
    const toTeacher = (await notes(teacherId, 'lesson.cancelled')).filter((n) =>
      n.dedupeKey.includes(lesson.id),
    );
    expect(toTeacher).toHaveLength(1);
    expect(toTeacher[0]!.payload).toMatchObject({ view: 'by-parent', by: 'Мария И', child: 'Петя И' });
    const toPetya = (await notes(petyaId, 'lesson.cancelled')).filter((n) => n.dedupeKey.includes(lesson.id));
    expect(toPetya).toHaveLength(1);
    expect(toPetya[0]!.payload).toMatchObject({ view: 'to-student', by: 'Мария И' });
  });

  it('UC-21 / CNL-03: in a group lesson the student reports absence — the lesson stays, their time is freed', async () => {
    const { lesson } = await create.execute(actor(teacherId, 'TEACHER'), {
      target: { groupId },
      startsAt: new Date('2026-10-26T13:00:00Z'),
      durationMin: 60,
    });
    await drainOutbox(ctx, tdb);
    expect(await cancel.preview(actor(petyaId, 'STUDENT'), lesson.id)).toEqual({
      outcome: 'absence',
      isLate: false,
    });
    const result = await cancel.execute(actor(petyaId, 'STUDENT'), {
      lessonId: lesson.id,
      reason: 'Контрольная',
    });
    expect(result.outcome).toBe('absence');
    const fresh = (await lessons.findById(lesson.id))!;
    expect(fresh.status).toBe('scheduled');
    expect(fresh.version).toBe(1);
    const participants = await lessons.listParticipants(lesson.id);
    expect(participants.find((p) => p.studentId === petyaId)).toMatchObject({
      attendance: 'absent_notified',
      absenceReason: 'Контрольная',
    });
    expect(participants.find((p) => p.studentId === mashaId)!.attendance).toBeNull();
    const busy = await busyOf(lesson.id);
    expect(busy.find((o) => o.accountId === petyaId)!.isActive).toBe(false);
    expect(busy.find((o) => o.accountId === mashaId)!.isActive).toBe(true);
    expect(busy.find((o) => o.accountId === teacherId)!.isActive).toBe(true);
    const items = await ctx.get(CancellationRepository).listItems(result.cancellation.id);
    expect(items[0]).toMatchObject({ action: 'absence', studentId: petyaId });
    await drainOutbox(ctx, tdb);
    const toTeacher = await notes(teacherId, 'lesson.absence');
    expect(toTeacher).toHaveLength(1);
    expect(toTeacher[0]!.payload).toMatchObject({
      view: 'by-student',
      student: 'Петя И',
      message: 'Контрольная',
    });
    const petyaReminders = (await notes(petyaId, 'lesson.reminder')).filter((n) =>
      n.dedupeKey.includes(lesson.id),
    );
    expect(petyaReminders.length).toBeGreaterThan(0);
    expect(petyaReminders.every((n) => n.status === 'cancelled')).toBe(true);
    const mashaReminders = (await notes(mashaId, 'lesson.reminder')).filter((n) =>
      n.dedupeKey.includes(lesson.id),
    );
    expect(mashaReminders.some((n) => n.status === 'scheduled')).toBe(true);
    // twice → CONFLICT; the parent's notice for the same child too
    await expect(
      cancel.execute(actor(petyaId, 'STUDENT'), { lessonId: lesson.id, reason: 'x' }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    // the parent of Petya reports Masha? no family link → NOT_FOUND
    await expect(
      cancel.execute(actor(mamaId, 'PARENT'), { lessonId: lesson.id, reason: 'x', studentId: mashaId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('CNL-05 (M-1): the student cancels → the parents are told as their own message; the parent cancels → no copy to themselves', async () => {
    ctx.clock.set('2026-10-19T12:00:00Z');
    const a = await individual('2026-11-03T13:00:00Z');
    await cancel.execute(actor(petyaId, 'STUDENT'), { lessonId: a.lesson.id, reason: 'Заболел' });
    await drainOutbox(ctx, tdb);
    const toMama = (await notes(mamaId, 'lesson.cancelled')).filter((n) => n.dedupeKey.includes(a.lesson.id));
    expect(toMama).toHaveLength(1);
    expect(toMama[0]!.payload).toMatchObject({
      view: 'by-student-to-parent',
      by: 'Петя И',
      teacher: 'Анна П',
    });
    expect(toMama[0]!.bot).toBe('parent');
    const b = await individual('2026-11-04T13:00:00Z');
    await cancel.execute(actor(mamaId, 'PARENT'), {
      lessonId: b.lesson.id,
      reason: 'Уезжаем',
      studentId: petyaId,
    });
    await drainOutbox(ctx, tdb);
    expect(
      (await notes(mamaId, 'lesson.cancelled')).filter((n) => n.dedupeKey.includes(b.lesson.id)),
    ).toHaveLength(0); // the initiator gets no copy
    expect(
      (await notes(petyaId, 'lesson.cancelled')).filter((n) => n.dedupeKey.includes(b.lesson.id)),
    ).toHaveLength(1);
  });
});
