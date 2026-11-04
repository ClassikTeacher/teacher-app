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
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { GroupsUseCase } from '@modules/people/groups/groups.use-case.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { BotApiModule } from '@telegram/api/bot-api.module.js';
import { AvailabilityRepository } from '../availability/availability.repository.js';
import { CreateLessonUseCase } from '../lessons/create-lesson.use-case.js';
import { LessonRepository } from '../lessons/lesson.repository.js';
import { ScheduleModule } from '../schedule.module.js';
import { BulkCancelUseCase } from './bulk-cancel.use-case.js';
import { CancellationRepository } from './cancellation.repository.js';

const actor = (id: string, role: 'TEACHER' | 'STUDENT' | 'PARENT'): Actor => ({
  accountId: id,
  roles: [role],
  status: 'active',
  source: 'bot',
});
const utc = (iso: string) => new Date(iso);

describe('UC-22 / UC-23: bulk cancellation (5.7.5, CNL-10, NTF-07)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let bulk: BulkCancelUseCase;
  let create: CreateLessonUseCase;
  let lessons: LessonRepository;
  let annaId: string;
  let olegId: string;
  let petyaId: string;
  let mashaId: string;
  let mamaId: string;
  let groupId: string;

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
    ]);
    bulk = ctx.get(BulkCancelUseCase);
    create = ctx.get(CreateLessonUseCase);
    lessons = ctx.get(LessonRepository);
    const profiles = ctx.get(TeacherProfileRepository);
    annaId = (
      await createAccount(tdb.txm, {
        roles: ['TEACHER'],
        firstName: 'Анна',
        lastName: 'П',
        timezone: 'Europe/Minsk',
      })
    ).id;
    olegId = (await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Олег', lastName: 'Б' })).id;
    await profiles.upsert(annaId, {
      subjectIds: [MATH_ID],
      onboardedAt: ctx.clock.now(),
      lateCancelHours: 24,
    });
    await profiles.upsert(olegId, {
      subjectIds: [MATH_ID],
      onboardedAt: ctx.clock.now(),
      studentCanCancel: false,
    });
    petyaId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Петя', lastName: 'И' })).id;
    mashaId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Маша', lastName: 'С' })).id;
    mamaId = (await createAccount(tdb.txm, { roles: ['PARENT'], firstName: 'Мария', lastName: 'И' })).id;
    for (const t of [annaId, olegId]) {
      await linkStudent(ctx, t, petyaId, { maxLessonsPerWeek: null });
      await linkStudent(ctx, t, mashaId, { maxLessonsPerWeek: null });
    }
    await ctx.get(FamilyLinkRepository).insert({
      parentId: mamaId,
      studentId: petyaId,
      invitedBy: annaId,
      invitationId: null,
      confirmedAt: ctx.clock.now(),
    });
    const groups = ctx.get(GroupsUseCase);
    groupId = (await groups.create(actor(annaId, 'TEACHER'), { name: '10А', subjectId: MATH_ID })).id;
    await groups.addMember(actor(annaId, 'TEACHER'), groupId, petyaId);
    await groups.addMember(actor(annaId, 'TEACHER'), groupId, mashaId);
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  const lessonAt = (
    teacherId: string,
    startIso: string,
    target: { studentId: string } | { groupId: string },
  ) => create.execute(actor(teacherId, 'TEACHER'), { target, startsAt: utc(startIso), durationMin: 60 });

  it('UC-22: the teacher cancels a week, group lessons included, closes the windows; each student gets one summary', async () => {
    ctx.clock.set('2026-10-19T12:00:00Z');
    const a = await lessonAt(annaId, '2026-10-20T09:00:00Z', { studentId: petyaId }); // late (21 h)
    const b = await lessonAt(annaId, '2026-10-22T09:00:00Z', { studentId: mashaId });
    const g = await lessonAt(annaId, '2026-10-23T09:00:00Z', { groupId });
    const outside = await lessonAt(annaId, '2026-10-28T09:00:00Z', { studentId: petyaId });
    const range = { start: utc('2026-10-19T21:00:00Z'), end: utc('2026-10-25T21:00:00Z') }; // Mon–Sat Minsk
    const preview = await bulk.previewTeacher(actor(annaId, 'TEACHER'), { range });
    expect(preview.items.map((i) => i.lesson.id).sort()).toEqual(
      [a.lesson.id, b.lesson.id, g.lesson.id].sort(),
    );
    expect(preview.lateCount).toBe(1);
    const result = await bulk.executeTeacher(
      actor(annaId, 'TEACHER'),
      { range },
      { reason: 'Заболела', closeWindows: true },
    );
    expect(result.items).toHaveLength(3);
    expect(result.closedDays).toEqual([
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
    ]);
    for (const id of [a.lesson.id, b.lesson.id, g.lesson.id])
      expect((await lessons.findById(id))!).toMatchObject({
        status: 'cancelled',
        cancellationId: result.cancellationId,
      });
    expect((await lessons.findById(outside.lesson.id))!.status).toBe('scheduled');
    const act = (await ctx.get(CancellationRepository).findById(result.cancellationId!))!;
    expect(act).toMatchObject({ kind: 'bulk', initiatorRole: 'TEACHER', reason: 'Заболела' });
    expect(await ctx.get(CancellationRepository).listItems(act.id)).toHaveLength(3);
    const closed = await ctx.get(AvailabilityRepository).listExceptions(annaId, '2026-10-19', '2026-10-26');
    expect(closed.filter((e) => e.kind === 'closed' && e.startLocal === null)).toHaveLength(6);
    await drainOutbox(ctx, tdb);
    // NTF-07: Petya has two lessons in the batch (own + group) → one message; per-lesson messages are suppressed
    const petya = await notes(petyaId, 'cancellation.bulk');
    expect(petya).toHaveLength(1);
    expect(petya[0]!.payload).toMatchObject({ view: 'by-teacher', cancelledCount: 2, message: 'Заболела' });
    expect(String(petya[0]!.payload['cancelled'])).toContain('вт 20.10');
    expect(await notes(petyaId, 'lesson.cancelled')).toHaveLength(0);
    expect(await notes(mashaId, 'cancellation.bulk')).toHaveLength(1);
    const reminders = (await notes(petyaId, 'lesson.reminder')).filter((n) =>
      n.dedupeKey.includes(a.lesson.id),
    );
    expect(reminders.every((n) => n.status === 'cancelled')).toBe(true);
    // a second run over the same period finds nothing: no cancellation record is created
    const again = await bulk.executeTeacher(actor(annaId, 'TEACHER'), { range }, { reason: 'ещё' });
    expect(again.items).toHaveLength(0);
    expect(again.cancellationId).toBeNull();
  });

  it('UC-22: by student / by group / by ids; foreign ids are ignored; the reason is mandatory', async () => {
    const p1 = await lessonAt(annaId, '2026-11-02T09:00:00Z', { studentId: petyaId });
    const m1 = await lessonAt(annaId, '2026-11-03T09:00:00Z', { studentId: mashaId });
    const g1 = await lessonAt(annaId, '2026-11-04T09:00:00Z', { groupId });
    const o1 = await lessonAt(olegId, '2026-11-05T09:00:00Z', { studentId: petyaId });
    const range = { start: utc('2026-11-01T00:00:00Z'), end: utc('2026-11-08T00:00:00Z') };
    const byStudent = await bulk.previewTeacher(actor(annaId, 'TEACHER'), {
      range,
      target: { studentId: petyaId },
    });
    expect(byStudent.items.map((i) => i.lesson.id)).toEqual([p1.lesson.id]); // individual lessons only
    const byGroup = await bulk.previewTeacher(actor(annaId, 'TEACHER'), { range, target: { groupId } });
    expect(byGroup.items.map((i) => i.lesson.id)).toEqual([g1.lesson.id]);
    const byIds = await bulk.previewTeacher(actor(annaId, 'TEACHER'), {
      lessonIds: [m1.lesson.id, o1.lesson.id],
    });
    expect(byIds.items.map((i) => i.lesson.id)).toEqual([m1.lesson.id]);
    await expect(
      bulk.executeTeacher(actor(annaId, 'TEACHER'), { lessonIds: [m1.lesson.id] }, { reason: ' ' }),
    ).rejects.toMatchObject({ code: 'CANCEL_REASON_REQUIRED' });
    await expect(
      bulk.previewTeacher(actor(annaId, 'TEACHER'), { range: { start: range.end, end: range.start } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(bulk.previewTeacher(actor(petyaId, 'STUDENT'), { range })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('UC-23: the student cancels a period at every teacher — group lessons become absences, forbidden ones are excluded, each teacher gets one summary', async () => {
    ctx.clock.set('2026-10-19T12:00:00Z');
    const a1 = await lessonAt(annaId, '2026-11-10T09:00:00Z', { studentId: petyaId });
    const g1 = await lessonAt(annaId, '2026-11-11T09:00:00Z', { groupId });
    const o1 = await lessonAt(olegId, '2026-11-12T09:00:00Z', { studentId: petyaId }); // Oleg forbids cancelling
    const m1 = await lessonAt(annaId, '2026-11-13T09:00:00Z', { studentId: mashaId }); // not Petya's
    const range = { start: utc('2026-11-09T00:00:00Z'), end: utc('2026-11-16T00:00:00Z') };
    const preview = await bulk.previewPerson(actor(petyaId, 'STUDENT'), 'STUDENT', { range });
    expect(preview.items.map((i) => [i.lesson.id, i.outcome])).toEqual([
      [a1.lesson.id, 'cancel'],
      [g1.lesson.id, 'absence'],
    ]);
    expect(preview.excluded).toEqual([
      expect.objectContaining({
        lesson: expect.objectContaining({ id: o1.lesson.id }),
        code: 'CANCEL_DISABLED',
      }),
    ]);
    const result = await bulk.executePerson(
      actor(petyaId, 'STUDENT'),
      'STUDENT',
      { range },
      { reason: 'Болею всю неделю' },
    );
    expect(result.items).toHaveLength(2);
    expect((await lessons.findById(a1.lesson.id))!.status).toBe('cancelled');
    expect((await lessons.findById(g1.lesson.id))!.status).toBe('scheduled');
    expect(
      (await lessons.listParticipants(g1.lesson.id)).find((p) => p.studentId === petyaId)!.attendance,
    ).toBe('absent_notified');
    expect((await lessons.findById(o1.lesson.id))!.status).toBe('scheduled');
    expect((await lessons.findById(m1.lesson.id))!.status).toBe('scheduled');
    await drainOutbox(ctx, tdb);
    const anna = await notes(annaId, 'cancellation.bulk');
    expect(anna).toHaveLength(1);
    expect(anna[0]!.payload).toMatchObject({
      view: 'by-student',
      by: 'Петя И',
      cancelledCount: 1,
      absenceCount: 1,
    });
    expect(await notes(olegId, 'cancellation.bulk')).toHaveLength(0);
    expect(await notes(annaId, 'lesson.cancelled')).toHaveLength(0);
    expect(await notes(annaId, 'lesson.absence')).toHaveLength(0);
    // only at one teacher, by ids, and the absence already reported is excluded now
    const byTeacher = await bulk.previewPerson(actor(petyaId, 'STUDENT'), 'STUDENT', {
      range,
      teacherId: olegId,
    });
    expect(byTeacher.items).toHaveLength(0);
    expect(byTeacher.excluded).toHaveLength(1);
    const byIds = await bulk.previewPerson(actor(petyaId, 'STUDENT'), 'STUDENT', {
      lessonIds: [g1.lesson.id, m1.lesson.id],
    });
    expect(byIds.items).toHaveLength(0);
    expect(byIds.excluded.map((e) => e.code)).toEqual(['ALREADY_REPORTED']);
  });

  it('CNL-10 guards: re-check under the lock, no silent truncation, windows only for a whole period, limit checked first', async () => {
    ctx.clock.set('2026-10-19T12:00:00Z');
    const a = await lessonAt(annaId, '2026-12-01T09:00:00Z', { studentId: petyaId });
    const b = await lessonAt(annaId, '2026-12-02T09:00:00Z', { studentId: mashaId });
    // b is cancelled by someone else after the preview: the batch applies to a only, b is reported as excluded
    const preview = await bulk.previewTeacher(actor(annaId, 'TEACHER'), {
      lessonIds: [a.lesson.id, b.lesson.id],
    });
    expect(preview.items).toHaveLength(2);
    await lessons.update(b.lesson.id, { status: 'cancelled', cancelledAt: ctx.clock.now() });
    const result = await bulk.executeTeacher(
      actor(annaId, 'TEACHER'),
      { lessonIds: [a.lesson.id, b.lesson.id] },
      { reason: 'x', closeWindows: true },
    );
    expect(result.items.map((i) => i.lesson.id)).toEqual([a.lesson.id]);
    expect(result.excluded.map((e) => [e.lesson.id, e.code])).toEqual([[b.lesson.id, 'CONFLICT']]);
    expect(result.closedDays).toEqual([]); // ids mode: no period to close
    // a student's period never closes the windows; the exceptions limit is checked before any write
    const range = { start: utc('2026-12-07T00:00:00Z'), end: utc('2026-12-14T00:00:00Z') };
    const c = await lessonAt(annaId, '2026-12-08T09:00:00Z', { studentId: petyaId });
    const withTarget = await bulk.executeTeacher(
      actor(annaId, 'TEACHER'),
      { range, target: { studentId: petyaId } },
      { reason: 'x', closeWindows: true },
    );
    expect(withTarget.items.map((i) => i.lesson.id)).toEqual([c.lesson.id]);
    expect(withTarget.closedDays).toEqual([]);
    const d = await lessonAt(annaId, '2026-12-09T09:00:00Z', { studentId: mashaId });
    const exceptions = ctx.get(AvailabilityRepository);
    for (let i = 0; i < 195; i += 1) {
      const day = new Date(Date.UTC(2027, 0, 1) + i * 864e5).toISOString().slice(0, 10);
      await exceptions.insertException({
        teacherId: annaId,
        date: day,
        kind: 'closed',
        startLocal: null,
        endLocal: null,
      });
    }
    await expect(
      bulk.executeTeacher(actor(annaId, 'TEACHER'), { range }, { reason: 'x', closeWindows: true }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect((await lessons.findById(d.lesson.id))!.status).toBe('scheduled'); // nothing was cancelled
  });

  it('UC-23: the parent cancels for the child; a stranger child is refused', async () => {
    const a1 = await lessonAt(annaId, '2026-11-17T09:00:00Z', { studentId: petyaId });
    const range = { start: utc('2026-11-16T00:00:00Z'), end: utc('2026-11-23T00:00:00Z') };
    await expect(
      bulk.previewPerson(actor(mamaId, 'PARENT'), 'PARENT', { range }, mashaId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(bulk.previewPerson(actor(mamaId, 'PARENT'), 'PARENT', { range })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const result = await bulk.executePerson(
      actor(mamaId, 'PARENT'),
      'PARENT',
      { range },
      { reason: 'Уезжаем' },
      petyaId,
    );
    expect(result.items.map((i) => i.lesson.id)).toEqual([a1.lesson.id]);
    const act = (await ctx.get(CancellationRepository).findById(result.cancellationId!))!;
    expect(act).toMatchObject({ initiatorRole: 'PARENT', onBehalfOfStudentId: petyaId, kind: 'bulk' });
    await drainOutbox(ctx, tdb);
    const anna = (await notes(annaId, 'cancellation.bulk')).filter((n) => n.dedupeKey.includes(act.id));
    expect(anna[0]!.payload).toMatchObject({ view: 'by-parent', by: 'Мария И', child: 'Петя И' });
    const petya = (await notes(petyaId, 'cancellation.bulk')).filter((n) => n.dedupeKey.includes(act.id));
    expect(petya[0]!.payload).toMatchObject({ view: 'to-student', teacher: 'Анна П' });
  });
});
