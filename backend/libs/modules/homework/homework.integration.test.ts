import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount } from '@test/factories.js';
import { drainOutbox } from '@test/outbox.js';
import { linkStudent, MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import type { Actor } from '@modules/access/actor.js';
import { ContentModule } from '@modules/content/content.module.js';
import { FileRepository } from '@modules/files/file.repository.js';
import { FilesModule } from '@modules/files/files.module.js';
import { DailyDigestJob } from '@modules/notifications/digest.job.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { notification } from '@modules/notifications/schema.js';
import { GroupsUseCase } from '@modules/people/groups/groups.use-case.js';
import { EndLinkUseCase } from '@modules/people/links/end-link.use-case.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { BulkCancelUseCase } from '@modules/schedule/cancellations/bulk-cancel.use-case.js';
import { CancelLessonUseCase } from '@modules/schedule/cancellations/cancel-lesson.use-case.js';
import { CreateLessonUseCase } from '@modules/schedule/lessons/create-lesson.use-case.js';
import { RescheduleLessonUseCase } from '@modules/schedule/reschedule/reschedule-lesson.use-case.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { AssignmentRepository } from './assignment.repository.js';
import { AssignmentsUseCase } from './assignments.use-case.js';
import { HomeworkModule } from './homework.module.js';
import { HomeworkQuery } from './homework.query.js';
import { OverdueAssignmentsJob } from './overdue.job.js';
import { ReviewUseCase } from './review.use-case.js';
import { SubmitUseCase } from './submit.use-case.js';

describe('M5-03/M5-04 homework: due dates per target, recalculation, withdrawal, overdue, submit, review', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let teacherId: string;
  let petyaId: string;
  let mashaId: string;
  const teacher = (): Actor => ({
    accountId: teacherId,
    roles: ['TEACHER'],
    status: 'active',
    source: 'bot',
  });
  const student = (id: string): Actor => ({
    accountId: id,
    roles: ['STUDENT'],
    status: 'active',
    source: 'bot',
  });
  const sent = (type: string, recipientId?: string) =>
    tdb.db
      .select()
      .from(notification)
      .where(
        and(
          eq(notification.typeCode, type),
          recipientId ? eq(notification.recipientId, recipientId) : undefined,
        ),
      );
  const reminders = (targetId: string) =>
    tdb.db
      .select()
      .from(notification)
      .where(like(notification.dedupeKey, `homework.due_soon:${targetId}:%`));

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(
      tdb,
      [
        AccessModule,
        PeopleModule,
        FilesModule,
        ScheduleModule,
        ContentModule,
        HomeworkModule,
        NotificationsModule,
      ],
      { now: '2026-11-02T08:00:00Z' },
    );
    teacherId = (
      await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Анна', timezone: 'Europe/Minsk' })
    ).id;
    await ctx
      .get(TeacherProfileRepository)
      .upsert(teacherId, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now() });
    petyaId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Петя' })).id;
    mashaId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Маша' })).id;
    await linkStudent(ctx, teacherId, petyaId, { maxLessonsPerWeek: null });
    await linkStudent(ctx, teacherId, mashaId, { maxLessonsPerWeek: null });
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('«к следующему занятию»: each student gets their own due date; a move and a cancellation recompute it', async () => {
    const lessons = ctx.get(CreateLessonUseCase);
    const petyaLesson = (
      await lessons.execute(teacher(), {
        target: { studentId: petyaId },
        startsAt: new Date('2026-11-04T10:00:00Z'),
        durationMin: 60,
      })
    ).lesson;
    await lessons.execute(teacher(), {
      target: { studentId: mashaId },
      startsAt: new Date('2026-11-06T10:00:00Z'),
      durationMin: 60,
    });
    await drainOutbox(ctx, tdb);
    const a = await ctx.get(AssignmentsUseCase).create(teacher(), {
      title: 'Квадратные уравнения',
      dueMode: 'next_lesson',
      submissionMode: 'files_text',
      studentIds: [petyaId, mashaId],
    });
    expect(a.status).toBe('published');
    const repo = ctx.get(AssignmentRepository);
    const petya = (await repo.findTargetOf(a.id, petyaId))!;
    const masha = (await repo.findTargetOf(a.id, mashaId))!;
    expect(petya.dueAt?.toISOString()).toBe('2026-11-04T10:00:00.000Z');
    expect(masha.dueAt?.toISOString()).toBe('2026-11-06T10:00:00.000Z');
    await drainOutbox(ctx, tdb);
    expect((await sent('homework.assigned')).map((n) => n.recipientId).sort()).toEqual(
      [petyaId, mashaId].sort(),
    );
    expect((await reminders(petya.id)).map((n) => n.dueAt.toISOString()).sort()).toEqual([
      '2026-11-03T10:00:00.000Z',
      '2026-11-04T08:00:00.000Z',
    ]);

    // the lesson moves → the due date follows, reminders are replanned (M4-03 contract)
    await ctx
      .get(RescheduleLessonUseCase)
      .execute(teacher(), { lessonId: petyaLesson.id, startsAt: new Date('2026-11-05T10:00:00Z') });
    await drainOutbox(ctx, tdb);
    expect((await repo.findTarget(petya.id))!.dueAt?.toISOString()).toBe('2026-11-05T10:00:00.000Z');
    const planned = (await reminders(petya.id)).filter((n) => n.status !== 'cancelled');
    expect(planned.map((n) => n.dueAt.toISOString()).sort()).toEqual([
      '2026-11-04T10:00:00.000Z',
      '2026-11-05T08:00:00.000Z',
    ]);

    // the lesson is cancelled and there is no other → no due date (the target waits for a lesson)
    await ctx.get(CancelLessonUseCase).execute(teacher(), { lessonId: petyaLesson.id, reason: 'Болею' });
    await drainOutbox(ctx, tdb);
    expect((await repo.findTarget(petya.id))!.dueAt).toBeNull();
    expect((await reminders(petya.id)).every((n) => n.status === 'cancelled')).toBe(true);
    // a new lesson gives the date back
    await lessons.execute(teacher(), {
      target: { studentId: petyaId },
      startsAt: new Date('2026-11-08T10:00:00Z'),
      durationMin: 60,
    });
    await drainOutbox(ctx, tdb);
    expect((await repo.findTarget(petya.id))!.dueAt?.toISOString()).toBe('2026-11-08T10:00:00.000Z');
  });

  it('M5-REVIEW H-1/M-1: a bulk cancellation recomputes next-lesson dues; an ended link withdraws submitted work', async () => {
    const lessons = ctx.get(CreateLessonUseCase);
    const use = ctx.get(AssignmentsUseCase);
    const repo = ctx.get(AssignmentRepository);
    const vacationId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Витя' })).id;
    await linkStudent(ctx, teacherId, vacationId, { maxLessonsPerWeek: null });
    const first = (
      await lessons.execute(teacher(), {
        target: { studentId: vacationId },
        startsAt: new Date('2026-11-10T10:00:00Z'),
        durationMin: 60,
      })
    ).lesson;
    await lessons.execute(teacher(), {
      target: { studentId: vacationId },
      startsAt: new Date('2026-11-17T10:00:00Z'),
      durationMin: 60,
    });
    await drainOutbox(ctx, tdb);
    const hw = await use.create(teacher(), {
      title: 'На каникулы',
      dueMode: 'next_lesson',
      submissionMode: 'text',
      studentIds: [vacationId],
    });
    expect((await repo.findTargetOf(hw.id, vacationId))!.dueLessonId).toBe(first.id);
    // the teacher cancels the week (UC-22): the due date moves to the lesson after the holiday
    await ctx
      .get(BulkCancelUseCase)
      .executeTeacher(
        teacher(),
        { range: { start: new Date('2026-11-09T00:00:00Z'), end: new Date('2026-11-13T00:00:00Z') } },
        { reason: 'Отпуск' },
      );
    await drainOutbox(ctx, tdb);
    const moved = (await repo.findTargetOf(hw.id, vacationId))!;
    expect(moved.dueAt?.toISOString()).toBe('2026-11-17T10:00:00.000Z');
    expect(moved.status).toBe('assigned');

    // handed in, then the link ends: the work leaves the queue (withdrawn), no verdict goes to a former student
    await ctx
      .get(SubmitUseCase)
      .execute(student(vacationId), { assignmentId: hw.id, fileIds: [], text: 'готово' });
    expect(await ctx.get(HomeworkQuery).queueCount(teacherId)).toBeGreaterThanOrEqual(1);
    const link = (await ctx.get(TeacherStudentRepository).findByPair(teacherId, vacationId))!;
    await ctx
      .get(EndLinkUseCase)
      .execute(teacher(), link.id, { reason: 'removed_by_teacher', message: 'Уехал' });
    await drainOutbox(ctx, tdb);
    expect((await repo.findTargetOf(hw.id, vacationId))!.status).toBe('withdrawn');
    const queue = await ctx.get(HomeworkQuery).queue(teacherId);
    expect(queue.some((c) => c.assignment.id === hw.id)).toBe(false);
  });

  it('a group assignment follows membership; closing withdraws; an ended link withdraws (5.8.4)', async () => {
    const groups = ctx.get(GroupsUseCase);
    const group = await groups.create(teacher(), { name: '9Б', subjectId: MATH_ID });
    await groups.addMember(teacher(), group.id, petyaId);
    const a = await ctx.get(AssignmentsUseCase).create(teacher(), {
      title: 'Параграф 3',
      dueMode: 'none',
      submissionMode: 'mark',
      groupIds: [group.id],
    });
    const repo = ctx.get(AssignmentRepository);
    expect((await repo.listTargets(a.id)).map((t) => t.studentId)).toEqual([petyaId]);
    await groups.addMember(teacher(), group.id, mashaId);
    await drainOutbox(ctx, tdb);
    const masha = await repo.findTargetOf(a.id, mashaId);
    expect(masha?.status).toBe('assigned');
    expect((await sent('homework.assigned', mashaId)).length).toBeGreaterThan(0);

    // Masha marks it done («Выполнено»), Petya never does; closing withdraws Petya only
    await ctx.get(SubmitUseCase).execute(student(mashaId), { assignmentId: a.id, fileIds: [] });
    await ctx.get(AssignmentsUseCase).close(teacher(), a.id);
    expect((await repo.findTargetOf(a.id, petyaId))!.status).toBe('withdrawn');
    expect((await repo.findTargetOf(a.id, mashaId))!.status).toBe('submitted');

    // an ended link withdraws the student's open targets at this teacher, not at another one
    const vasyaId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Вася' })).id;
    await linkStudent(ctx, teacherId, vasyaId, { maxLessonsPerWeek: null });
    const b = await ctx
      .get(AssignmentsUseCase)
      .create(teacher(), { title: 'Ещё', dueMode: 'none', submissionMode: 'text', studentIds: [vasyaId] });
    const other = (await createAccount(tdb.txm, { roles: ['TEACHER'] })).id;
    await ctx
      .get(TeacherProfileRepository)
      .upsert(other, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now() });
    await linkStudent(ctx, other, vasyaId);
    const foreign = await ctx
      .get(AssignmentsUseCase)
      .create(
        { ...teacher(), accountId: other },
        { title: 'Чужое', dueMode: 'none', submissionMode: 'text', studentIds: [vasyaId] },
      );
    const vasyaLink = (await ctx.get(TeacherStudentRepository).findByPair(teacherId, vasyaId))!;
    await ctx
      .get(EndLinkUseCase)
      .execute(teacher(), vasyaLink.id, { reason: 'removed_by_teacher', message: 'Переезд' });
    await drainOutbox(ctx, tdb);
    expect((await repo.findTargetOf(b.id, vasyaId))!.status).toBe('withdrawn');
    expect((await repo.findTargetOf(foreign.id, vasyaId))!.status).toBe('assigned');
  });

  it('UC-40 overdue sweep, UC-27 late rules and files, UC-28 review with a required comment; stats and digest', async () => {
    const use = ctx.get(AssignmentsUseCase);
    const repo = ctx.get(AssignmentRepository);
    const noLate = await use.create(teacher(), {
      title: 'Строго в срок',
      dueMode: 'fixed',
      dueAt: new Date('2026-11-03T18:00:00Z'),
      submissionMode: 'text',
      submissionRules: { acceptLate: false },
      studentIds: [petyaId],
    });
    const flexible = await use.create(teacher(), {
      title: 'Можно позже',
      dueMode: 'fixed',
      dueAt: new Date('2026-11-03T18:00:00Z'),
      submissionMode: 'files_text',
      studentIds: [petyaId],
    });
    ctx.clock.set('2026-11-03T18:05:00Z');
    expect(await ctx.get(OverdueAssignmentsJob).run()).toBe(2);
    expect(await ctx.get(OverdueAssignmentsJob).run()).toBe(0); // idempotent
    await drainOutbox(ctx, tdb);
    expect((await sent('homework.overdue', petyaId)).length).toBe(2);
    const submit = ctx.get(SubmitUseCase);
    await expect(
      submit.execute(student(petyaId), { assignmentId: noLate.id, fileIds: [], text: 'x = 2' }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'late_forbidden' },
    });
    await expect(
      submit.execute(student(petyaId), { assignmentId: flexible.id, fileIds: [], text: '' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const fakeFile = '019a0000-0000-7000-8000-0000000000aa';
    await expect(
      submit.execute(student(petyaId), { assignmentId: flexible.id, fileIds: [fakeFile], text: 'см. файл' }),
    ).rejects.toMatchObject({
      details: { reason: 'files_expired' },
    });
    const s1 = await submit.execute(student(petyaId), {
      assignmentId: flexible.id,
      fileIds: [],
      text: 'x = 2 или x = 3',
    });
    expect(s1).toMatchObject({ attemptNo: 1, isLate: true });
    expect((await repo.findTargetOf(flexible.id, petyaId))!.status).toBe('submitted');
    await drainOutbox(ctx, tdb);
    const petyaReceived = (await sent('submission.received', teacherId)).filter((n) =>
      (n.payload as { student?: string }).student?.startsWith('Петя'),
    );
    expect(petyaReceived.length).toBe(1);
    expect(await ctx.get(HomeworkQuery).queueCount(teacherId)).toBeGreaterThanOrEqual(1);

    const review = ctx.get(ReviewUseCase);
    await expect(
      review.execute(teacher(), { submissionId: s1.id, decision: 'returned' }),
    ).rejects.toMatchObject({
      details: { reason: 'comment_required' },
    });
    const stranger: Actor = {
      ...teacher(),
      accountId: (await createAccount(tdb.txm, { roles: ['TEACHER'] })).id,
    };
    await expect(
      review.execute(stranger, { submissionId: s1.id, decision: 'accepted' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await review.execute(teacher(), {
      submissionId: s1.id,
      decision: 'returned',
      comment: 'Проверьте второй корень',
    });
    expect((await repo.findTargetOf(flexible.id, petyaId))!.status).toBe('returned');
    await expect(
      review.execute(teacher(), { submissionId: s1.id, decision: 'accepted' }),
    ).rejects.toMatchObject({ details: { reason: 'reviewed' } });
    const s2 = await submit.execute(student(petyaId), {
      assignmentId: flexible.id,
      fileIds: [],
      text: 'x = 2',
    });
    expect(s2.attemptNo).toBe(2);
    await review.execute(teacher(), { submissionId: s2.id, decision: 'accepted' });
    expect((await repo.findTargetOf(flexible.id, petyaId))!.status).toBe('accepted');
    await drainOutbox(ctx, tdb);
    expect(
      (await sent('submission.reviewed', petyaId))
        .map((n) => (n.payload as { decision: string }).decision)
        .sort(),
    ).toEqual(['accepted', 'returned']);
    expect(await ctx.get(FileRepository).usedBytes(teacherId)).toBe(0);

    const stats = await ctx.get(HomeworkQuery).stats(teacherId, petyaId, {
      start: new Date('2026-11-01T00:00:00Z'),
      end: new Date('2026-12-01T00:00:00Z'),
    });
    expect(stats).toMatchObject({ late: 1, accepted: 1 });
    expect(stats.notSubmitted).toBeGreaterThanOrEqual(1);

    // the morning digest counts unchecked work (an accepted target is final: a fresh assignment is used)
    const forDigest = await use.create(teacher(), {
      title: 'Для сводки',
      dueMode: 'none',
      submissionMode: 'text',
      studentIds: [petyaId],
    });
    const s3 = await submit.execute(student(petyaId), {
      assignmentId: forDigest.id,
      fileIds: [],
      text: 'ещё раз',
    });
    ctx.clock.set('2026-11-04T05:01:00Z'); // 08:01 Minsk
    expect(await ctx.get(DailyDigestJob).run()).toBeGreaterThanOrEqual(1);
    const digest = (await sent('digest.daily', teacherId))[0]!;
    expect((digest.payload as { unchecked: number }).unchecked).toBeGreaterThanOrEqual(1);
    await review.execute(teacher(), { submissionId: s3.id, decision: 'accepted' });
  });
});
