import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount } from '@test/factories.js';
import { drainOutbox } from '@test/outbox.js';
import { linkStudent, MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import type { Actor } from '@modules/access/actor.js';
import { ContentModule } from '@modules/content/content.module.js';
import { FilesModule } from '@modules/files/files.module.js';
import { AssignmentsUseCase } from '@modules/homework/assignments.use-case.js';
import { HomeworkModule } from '@modules/homework/homework.module.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { notification } from '@modules/notifications/schema.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { CancelLessonUseCase } from '@modules/schedule/cancellations/cancel-lesson.use-case.js';
import { CreateLessonUseCase } from '@modules/schedule/lessons/create-lesson.use-case.js';
import { LessonReportUseCase } from '@modules/schedule/lessons/lesson-report.use-case.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { GradeEntriesUseCase } from './grade-entries.use-case.js';
import { GradebookModule } from './gradebook.module.js';
import { JournalsUseCase } from './journals.use-case.js';
import { renderReport } from './report-text.js';
import { ReportsUseCase } from './reports.use-case.js';

describe('M6-03 reports (UC-31, 5.12): snapshot of a period, sending with copies, read policy', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let reports: ReportsUseCase;
  let teacherId: string;
  let petyaId: string;
  let mamaId: string;
  let linkId: string;
  const actor = (id: string, role: Actor['roles'][number]): Actor => ({
    accountId: id,
    roles: [role],
    status: 'active',
    source: 'bot',
  });
  const teacher = () => actor(teacherId, 'TEACHER');
  const sent = (type: string, recipientId: string) =>
    tdb.db
      .select()
      .from(notification)
      .where(and(eq(notification.typeCode, type), eq(notification.recipientId, recipientId)));

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(
      tdb,
      [
        AccessModule,
        PeopleModule,
        GradebookModule,
        FilesModule,
        ScheduleModule,
        ContentModule,
        HomeworkModule,
        NotificationsModule,
      ],
      { now: '2026-10-05T10:00:00Z' },
    );
    reports = ctx.get(ReportsUseCase);
    teacherId = (
      await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Анна', timezone: 'Europe/Minsk' })
    ).id;
    await ctx
      .get(TeacherProfileRepository)
      .upsert(teacherId, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now() });
    petyaId = (
      await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Петя', timezone: 'Europe/Minsk' })
    ).id;
    mamaId = (await createAccount(tdb.txm, { roles: ['PARENT'], firstName: 'Мама' })).id;
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

    // October: two lessons held (one late), one cancelled late by the student, one assignment, three marks
    const lessons = ctx.get(CreateLessonUseCase);
    const a = (
      await lessons.execute(teacher(), {
        target: { studentId: petyaId },
        startsAt: new Date('2026-10-06T10:00:00Z'),
        durationMin: 60,
      })
    ).lesson;
    const b = (
      await lessons.execute(teacher(), {
        target: { studentId: petyaId },
        startsAt: new Date('2026-10-13T10:00:00Z'),
        durationMin: 60,
      })
    ).lesson;
    const c = (
      await lessons.execute(teacher(), {
        target: { studentId: petyaId },
        startsAt: new Date('2026-10-20T10:00:00Z'),
        durationMin: 60,
      })
    ).lesson;
    await ctx.get(AssignmentsUseCase).create(teacher(), {
      title: 'Дроби',
      dueMode: 'fixed',
      dueAt: new Date('2026-10-12T18:00:00Z'),
      submissionMode: 'text',
      studentIds: [petyaId],
    });
    ctx.clock.set('2026-10-19T12:00:00Z');
    await ctx
      .get(CancelLessonUseCase)
      .execute(actor(petyaId, 'STUDENT'), { lessonId: c.id, reason: 'Болею' });
    ctx.clock.set('2026-10-21T12:00:00Z');
    const report = ctx.get(LessonReportUseCase);
    await report.complete(teacher(), a.id, {
      topic: 'Дроби',
      attendance: [{ studentId: petyaId, attendance: 'present' }],
    });
    await report.complete(teacher(), b.id, {
      topic: 'Проценты',
      attendance: [{ studentId: petyaId, attendance: 'late' }],
    });
    const entries = ctx.get(GradeEntriesUseCase);
    const school = await entries.journalFor(teacher(), petyaId, MATH_ID, 'school');
    const tests = await entries.journalFor(teacher(), petyaId, MATH_ID, 'tests');
    await entries.add(teacher(), { journalId: school.id, value: 8, date: '2026-10-06', lessonId: a.id });
    await entries.add(teacher(), { journalId: school.id, value: 6, date: '2026-10-13', category: 'control' });
    await entries.add(teacher(), { journalId: tests.id, value: 70, date: '2026-10-15' });
    await entries.add(teacher(), { journalId: school.id, value: 10, date: '2026-09-20' }); // outside the period
    await drainOutbox(ctx, tdb);
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('builds the snapshot of October: lessons, attendance, the late cancellation, homework and journals', async () => {
    const snapshot = await reports.preview(teacher(), { linkId, from: '2026-10-01', to: '2026-10-31' });
    expect(snapshot.lessons).toMatchObject({
      held: 2,
      notHeld: 0,
      topics: ['Дроби', 'Проценты'],
      attendance: { present: 1, late: 1, absent_notified: 0, absent: 0 },
      cancelled: { total: 1, byStudent: 1, byTeacher: 0, late: 1 },
    });
    expect(snapshot.homework).toMatchObject({ assigned: 1, notSubmitted: 1, averageMark: null });
    expect(snapshot.subjects).toHaveLength(1);
    expect(snapshot.subjects[0]).toMatchObject({
      name: 'Математика',
      school: { count: 2, average: 7 },
      tests: { count: 1, average: 70, targetPercent: null },
    });
    const text = renderReport((k) => k, snapshot, 'Молодец');
    expect(text).toContain('rpt-title');
    expect(text).toContain('rpt-teacher-comment');
    // validation
    await expect(
      reports.preview(teacher(), { linkId, from: '2026-10-31', to: '2026-10-01' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      reports.preview(teacher(), { linkId, from: '2025-01-01', to: '2026-10-01' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const other = (await createAccount(tdb.txm, { roles: ['TEACHER'] })).id;
    await ctx
      .get(TeacherProfileRepository)
      .upsert(other, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now() });
    await expect(
      reports.preview(actor(other, 'TEACHER'), { linkId, from: '2026-10-01', to: '2026-10-31' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a draft is sent once; the student gets the report with a copy to the parent; later journal changes do not alter it', async () => {
    const draft = await reports.create(teacher(), {
      linkId,
      from: '2026-10-01',
      to: '2026-10-31',
      comment: 'Молодец',
    });
    expect(draft.status).toBe('draft');
    expect((await reports.listForTeacher(teacher(), linkId)).map((v) => v.report.id)).toEqual([draft.id]);
    // not yet visible to the student
    expect(await reports.listForStudent(actor(petyaId, 'STUDENT'))).toEqual([]);
    await expect(reports.personReport(actor(petyaId, 'STUDENT'), draft.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const sentRow = await reports.send(teacher(), draft.id);
    expect(sentRow.status).toBe('sent');
    await expect(reports.send(teacher(), draft.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await drainOutbox(ctx, tdb);
    const toPetya = await sent('report.sent', petyaId);
    expect(toPetya).toHaveLength(1);
    expect(String(toPetya[0]!.payload['body'])).toContain('Проведено: 2');
    expect(String(toPetya[0]!.payload['body'])).toContain('Комментарий учителя:</b> Молодец');
    expect(await sent('report.sent', mamaId)).toHaveLength(1); // NTF-01: a copy by default
    // the snapshot is frozen
    const entries = ctx.get(GradeEntriesUseCase);
    const school = await entries.journalFor(teacher(), petyaId, MATH_ID, 'school');
    ctx.clock.set('2026-10-26T12:00:00Z');
    await entries.add(teacher(), { journalId: school.id, value: 1, date: '2026-10-25' });
    const again = await reports.teacherReport(teacher(), draft.id);
    expect(again.snapshot.subjects[0]!.school).toMatchObject({ count: 2, average: 7 });
    // read policy: the student and the parent see it, a stranger does not
    expect((await reports.listForStudent(actor(petyaId, 'STUDENT'))).map((v) => v.report.id)).toEqual([
      draft.id,
    ]);
    expect((await reports.listForChild(actor(mamaId, 'PARENT'), petyaId)).map((v) => v.report.id)).toEqual([
      draft.id,
    ]);
    expect((await reports.personReport(actor(mamaId, 'PARENT'), draft.id)).report.id).toBe(draft.id);
    const stranger = (await createAccount(tdb.txm, { roles: ['STUDENT'] })).id;
    await expect(reports.personReport(actor(stranger, 'STUDENT'), draft.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
