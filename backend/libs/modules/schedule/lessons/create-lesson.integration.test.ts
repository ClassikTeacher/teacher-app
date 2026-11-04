import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount } from '@test/factories.js';
import { drainOutbox } from '@test/outbox.js';
import { linkStudent, MATH_ID, PHYSICS_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import type { Actor } from '@modules/access/actor.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { notification } from '@modules/notifications/schema.js';
import { outboxEvent } from '@modules/outbox/schema.js';
import { GroupsUseCase } from '@modules/people/groups/groups.use-case.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { BotApiModule } from '@telegram/api/bot-api.module.js';
import { OccupancyRepository } from '../occupancy/occupancy.repository.js';
import { ScheduleModule } from '../schedule.module.js';
import { lesson as lessonTable } from '../schema.js';
import { CreateLessonUseCase } from './create-lesson.use-case.js';
import { LessonRepository } from './lesson.repository.js';
import { LessonsQuery } from './lessons.query.js';

const at = (day: number, h: number, m = 0) => new Date(Date.UTC(2026, 9, day, h, m));
const asTeacher = (id: string): Actor => ({
  accountId: id,
  roles: ['TEACHER'],
  status: 'active',
  source: 'bot',
});

describe('CreateLessonUseCase (UC-14) and group membership applied to future lessons (M3-02)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let create: CreateLessonUseCase;
  let teacherId: string;
  let otherTeacherId: string;
  let petyaId: string;
  let mashaId: string;
  let groupId: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [
      PeopleModule,
      AccessModule,
      ScheduleModule,
      BotApiModule,
      NotificationsModule,
    ]);
    create = ctx.get(CreateLessonUseCase);
    teacherId = (await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Анна' })).id;
    otherTeacherId = (await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Олег' })).id;
    const profiles = ctx.get(TeacherProfileRepository);
    await profiles.upsert(teacherId, {
      subjectIds: [MATH_ID],
      bufferBeforeMin: 0,
      bufferAfterMin: 10,
      onboardedAt: ctx.clock.now(),
    });
    await profiles.upsert(otherTeacherId, { subjectIds: [PHYSICS_ID], onboardedAt: ctx.clock.now() });
    petyaId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Петя' })).id;
    mashaId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Маша' })).id;
    await linkStudent(ctx, teacherId, petyaId, { subjectIds: [MATH_ID, PHYSICS_ID] });
    await linkStudent(ctx, teacherId, mashaId);
    await linkStudent(ctx, otherTeacherId, petyaId, { subjectIds: [PHYSICS_ID] });
    const group = await ctx
      .get(GroupsUseCase)
      .create(asTeacher(teacherId), { name: '10А', subjectId: MATH_ID });
    groupId = group.id;
    await ctx.get(GroupsUseCase).addMember(asTeacher(teacherId), groupId, petyaId);
    await drainOutbox(ctx, tdb); // nothing to apply yet, but keeps the outbox clean for the assertions below
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('creates an individual lesson: number, default subject, occupancy with the teacher buffer, event and messages', async () => {
    const { lesson, participants } = await create.execute(asTeacher(teacherId), {
      target: { studentId: petyaId },
      startsAt: at(21, 13),
      durationMin: 60,
    });
    expect(lesson).toMatchObject({
      seqNo: 1,
      subjectId: MATH_ID,
      groupId: null,
      status: 'scheduled',
      version: 1,
    });
    expect(participants.map((p) => p.studentId)).toEqual([petyaId]);
    const rows = await ctx.get(OccupancyRepository).listByLesson(lesson.id);
    const teacherRow = rows.find((r) => r.accountId === teacherId)!;
    expect(teacherRow.during).toEqual({ start: at(21, 13), end: at(21, 14, 10) });
    expect(teacherRow.bufferAfterMin).toBe(10);
    expect(rows.find((r) => r.accountId === petyaId)!.during).toEqual({ start: at(21, 13), end: at(21, 14) });
    const second = await create.execute(asTeacher(teacherId), {
      target: { studentId: petyaId },
      startsAt: at(22, 13),
      durationMin: 45,
    });
    expect(second.lesson.seqNo).toBe(2);
    expect((await ctx.get(LessonRepository).listEvents(lesson.id)).map((e) => e.type)).toEqual(['created']);
    await drainOutbox(ctx, tdb);
    const sent = await tdb.db.select().from(notification).where(eq(notification.recipientId, petyaId));
    expect(sent.map((n) => n.typeCode).sort()).toEqual([
      'lesson.created',
      'lesson.created',
      'lesson.reminder',
      'lesson.reminder',
      'lesson.reminder',
      'lesson.reminder',
    ]);
    expect(sent.find((n) => n.typeCode === 'lesson.created')!.payload).toMatchObject({
      subject: 'Математика',
      teacher: 'Анна User',
    });
    const teacherReminders = await tdb.db
      .select()
      .from(notification)
      .where(eq(notification.recipientId, teacherId));
    expect(teacherReminders.filter((n) => n.typeCode === 'lesson.reminder')).toHaveLength(4);
  });

  it('names the busy party without details (CAL-06): the teacher buffer, then the student at another teacher', async () => {
    await expect(
      create.execute(asTeacher(teacherId), {
        target: { studentId: mashaId },
        startsAt: at(21, 14, 5),
        durationMin: 30,
      }),
    ).rejects.toMatchObject({ code: 'LESSON_CONFLICT', details: { who: 'teacher' } });
    await expect(
      create.execute(asTeacher(otherTeacherId), {
        target: { studentId: petyaId },
        startsAt: at(21, 13, 30),
        durationMin: 60,
      }),
    ).rejects.toMatchObject({ code: 'LESSON_CONFLICT', details: { who: 'student', studentId: petyaId } });
    // the failed attempts left nothing behind
    const lessons = await ctx
      .get(LessonRepository)
      .listByTeacher(otherTeacherId, { start: at(20, 0), end: at(23, 0) });
    expect(lessons).toHaveLength(0);
    await expect(
      create.execute(asTeacher(otherTeacherId), {
        target: { studentId: mashaId },
        startsAt: at(21, 16),
        durationMin: 60,
      }),
    ).rejects.toMatchObject({ code: 'LINK_NOT_ACTIVE' });
    await expect(
      create.execute(asTeacher(otherTeacherId), {
        target: { groupId },
        startsAt: at(21, 16),
        durationMin: 60,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      create.execute(asTeacher(teacherId), {
        target: { studentId: petyaId },
        startsAt: at(18, 10),
        durationMin: 60,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { reason: 'past' } });
    await expect(
      create.execute(asTeacher(teacherId), {
        target: { studentId: petyaId },
        startsAt: at(21, 18),
        durationMin: 7,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('a group lesson takes the current members; later membership changes apply to future lessons with a conflict report', async () => {
    const groups = ctx.get(GroupsUseCase);
    const { lesson, participants } = await create.execute(asTeacher(teacherId), {
      target: { groupId },
      startsAt: at(23, 10),
      durationMin: 90,
    });
    expect(lesson).toMatchObject({ groupId, seqNo: null, subjectId: MATH_ID });
    expect(participants.map((p) => p.studentId)).toEqual([petyaId]);
    await drainOutbox(ctx, tdb);

    // Masha is busy at another teacher exactly then → she joins the lesson at 23.10? no: conflict reported
    await create.execute(asTeacher(otherTeacherId), {
      target: { studentId: petyaId },
      startsAt: at(24, 10),
      durationMin: 60,
    });
    const vasyaId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Вася' })).id;
    await linkStudent(ctx, teacherId, vasyaId);
    await linkStudent(ctx, otherTeacherId, vasyaId);
    await create.execute(asTeacher(otherTeacherId), {
      target: { studentId: vasyaId },
      startsAt: at(23, 10, 30),
      durationMin: 30,
    });
    await drainOutbox(ctx, tdb);

    await groups.addMember(asTeacher(teacherId), groupId, mashaId);
    await groups.addMember(asTeacher(teacherId), groupId, vasyaId);
    await drainOutbox(ctx, tdb);
    const repo = ctx.get(LessonRepository);
    let members = (await repo.listParticipants(lesson.id)).map((p) => p.studentId).sort();
    expect(members).toEqual([mashaId, petyaId].sort());
    expect((await repo.findById(lesson.id))!.version).toBe(2);
    const conflicts = await tdb.db
      .select()
      .from(notification)
      .where(eq(notification.typeCode, 'lesson.member_conflicts'));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.payload).toMatchObject({ student: 'Вася User' });
    expect(String(conflicts[0]!.payload['dates'])).toContain('23.10');
    const joined = await tdb.db.select().from(notification).where(eq(notification.recipientId, mashaId));
    expect(joined.map((n) => n.typeCode)).toContain('lesson.participants_changed');

    // re-delivery of the same event changes nothing
    const events = await tdb.db
      .select()
      .from(outboxEvent)
      .where(eq(outboxEvent.eventType, 'group.member_added'));
    await tdb.db
      .update(outboxEvent)
      .set({ publishedAt: null })
      .where(eq(outboxEvent.id, events.at(-1)!.id));
    await drainOutbox(ctx, tdb);
    expect((await repo.findById(lesson.id))!.version).toBe(2);

    await groups.removeMember(asTeacher(teacherId), groupId, petyaId);
    await drainOutbox(ctx, tdb);
    members = (await repo.listParticipants(lesson.id)).map((p) => p.studentId);
    expect(members).toEqual([mashaId]);
    const occupancy = await ctx.get(OccupancyRepository).listByLesson(lesson.id);
    expect(occupancy.map((o) => o.accountId).sort()).toEqual([mashaId, teacherId].sort());
    expect((await repo.listEvents(lesson.id)).map((e) => e.type)).toEqual([
      'created',
      'participant_added',
      'participant_removed',
    ]);

    // exactly one reminder per offset and recipient survives the membership changes (NTF-08)
    const live = (await tdb.db.select().from(notification)).filter(
      (n) => n.typeCode === 'lesson.reminder' && n.status === 'scheduled' && n.dedupeKey.includes(lesson.id),
    );
    const perRecipient = new Map<string, number>();
    for (const n of live) perRecipient.set(n.recipientId, (perRecipient.get(n.recipientId) ?? 0) + 1);
    expect([...perRecipient.entries()].sort()).toEqual(
      [
        [mashaId, 2],
        [teacherId, 2],
      ].sort(),
    );

    // a stale member_added (the student already left) must not bring the student back
    const stale = events.at(-1)!; // Vasya's join, delivered once more after he was removed from the group
    await groups.removeMember(asTeacher(teacherId), groupId, vasyaId);
    await drainOutbox(ctx, tdb);
    await tdb.db.update(outboxEvent).set({ publishedAt: null }).where(eq(outboxEvent.id, stale.id));
    await drainOutbox(ctx, tdb);
    expect((await repo.listParticipants(lesson.id)).map((p) => p.studentId)).toEqual([mashaId]);
    // re-delivery with a conflict produced one teacher message, not two
    const conflictMessages = await tdb.db
      .select()
      .from(notification)
      .where(eq(notification.typeCode, 'lesson.member_conflicts'));
    expect(conflictMessages).toHaveLength(1);

    const view = await ctx.get(LessonsQuery).teacherLesson(teacherId, lesson.id);
    expect(view.participants.map((p) => p.displayName)).toEqual(['Маша User']);
    const targets = await ctx.get(LessonsQuery).targets(teacherId);
    expect(targets[0]).toMatchObject({ kind: 'group', groupId }); // scheduled most recently
    const all = await tdb.db.select().from(lessonTable).where(eq(lessonTable.teacherId, teacherId));
    expect(all).toHaveLength(3);
    const empty = await groups.create(asTeacher(teacherId), { name: 'Пустая' });
    await expect(
      create.execute(asTeacher(teacherId), {
        target: { groupId: empty.id },
        startsAt: at(25, 10),
        durationMin: 60,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { reason: 'empty_group' } });
  });
});
