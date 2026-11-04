import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount } from '@test/factories.js';
import { drainOutbox } from '@test/outbox.js';
import { linkStudent, MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import type { Actor } from '@modules/access/actor.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { notification } from '@modules/notifications/schema.js';
import { outboxEvent } from '@modules/outbox/schema.js';
import { EndLinkUseCase } from '@modules/people/links/end-link.use-case.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { BotApiModule } from '@telegram/api/bot-api.module.js';
import { CreateLessonUseCase } from '../lessons/create-lesson.use-case.js';
import { LessonRepository } from '../lessons/lesson.repository.js';
import { ScheduleModule } from '../schedule.module.js';
import { lesson as lessonTable } from '../schema.js';
import { SeriesMaterializer } from './series.materializer.js';
import { SeriesRepository } from './series.repository.js';
import { SeriesUseCase } from './series.use-case.js';

const asTeacher = (id: string): Actor => ({
  accountId: id,
  roles: ['TEACHER'],
  status: 'active',
  source: 'bot',
});
const utc = (iso: string) => new Date(iso);

describe('UC-15 / UC-39: series on a rolling horizon, conflicts reported, pause / end / split', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let series: SeriesUseCase;
  let lessons: LessonRepository;
  let teacherId: string;
  let studentId: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    // fixed clock Monday 2026-10-19 12:00Z; the teacher lives in Minsk (+3)
    ctx = await createTestContext(tdb, [
      PeopleModule,
      AccessModule,
      ScheduleModule,
      BotApiModule,
      NotificationsModule,
    ]);
    series = ctx.get(SeriesUseCase);
    lessons = ctx.get(LessonRepository);
    teacherId = (
      await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Анна', timezone: 'Europe/Minsk' })
    ).id;
    await ctx
      .get(TeacherProfileRepository)
      .upsert(teacherId, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now() });
    studentId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Петя' })).id;
    await linkStudent(ctx, teacherId, studentId);
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('creates 12 weeks of instances (two a week), skips a busy slot and reports it; the worker extends', async () => {
    // a one-off lesson already sits on Wednesday 21.10 16:00 Minsk (13:00Z): that instance must be skipped
    await ctx.get(CreateLessonUseCase).execute(asTeacher(teacherId), {
      target: { studentId },
      startsAt: utc('2026-10-21T13:00:00Z'),
      durationMin: 60,
    });
    const { series: created, report } = await series.create(asTeacher(teacherId), {
      target: { studentId },
      weekdays: [1, 3],
      startMin: 16 * 60,
      durationMin: 60,
      startsOn: '2026-10-19',
    });
    expect(created.rrule).toBe('FREQ=WEEKLY;BYDAY=MO,WE');
    expect(created.materializedUntil).toBe('2027-01-11'); // 12 weeks from 19.10
    expect(report.conflicts.map((c) => c.during.start.toISOString())).toEqual(['2026-10-21T13:00:00.000Z']);
    const instances = await tdb.db.select().from(lessonTable).where(eq(lessonTable.seriesId, created.id));
    expect(instances).toHaveLength(report.created);
    expect(report.created).toBe(24); // 13 Mondays + 12 Wednesdays − 1 conflict
    expect(instances.every((l) => l.createdVia === 'series' && l.subjectId === MATH_ID)).toBe(true);
    expect(instances.every((l) => l.startsAt.toISOString().endsWith('T13:00:00.000Z'))).toBe(true); // 16:00 Minsk
    await drainOutbox(ctx, tdb);
    const notices = await tdb.db
      .select()
      .from(notification)
      .where(eq(notification.typeCode, 'series.conflicts'));
    expect(notices).toHaveLength(1);
    expect(String(notices[0]!.payload['dates'])).toContain('ср 21.10 16:00');
    const toStudent = await tdb.db.select().from(notification).where(eq(notification.recipientId, studentId));
    expect(toStudent.filter((n) => n.typeCode === 'series.created')).toHaveLength(1);
    expect(toStudent.filter((n) => n.typeCode === 'lesson.created')).toHaveLength(1); // only the one-off lesson
    expect(toStudent.filter((n) => n.typeCode === 'lesson.reminder').length).toBeGreaterThan(40);

    // a worker pass changes nothing until the horizon moves
    expect(await ctx.get(SeriesMaterializer).run()).toBe(0);
    ctx.clock.set('2026-10-27T12:00:00Z');
    expect(await ctx.get(SeriesMaterializer).run()).toBe(1);
    expect((await ctx.get(SeriesRepository).findById(created.id))!.materializedUntil).toBe('2027-01-19');
    const extended = await tdb.db.select().from(lessonTable).where(eq(lessonTable.seriesId, created.id));
    expect(extended).toHaveLength(26); // Wed 13.01 and Mon 18.01 added
    ctx.clock.set('2026-10-19T12:00:00Z');
  });

  it('pause skips a period and reports its instances; "following" splits the series; end reports the rest', async () => {
    const t = asTeacher(teacherId);
    const { series: s } = await series.create(t, {
      target: { studentId },
      weekdays: [5],
      startMin: 10 * 60,
      durationMin: 45,
      startsOn: '2026-10-23',
      endsOn: '2026-12-31',
    });
    const repo = ctx.get(SeriesRepository);
    expect(await repo.scheduledInstanceIds(s.id, utc('2026-01-01T00:00:00Z'))).toHaveLength(10); // Fridays 23.10 … 25.12
    const paused = await series.pause(t, s.id, '2026-11-01', '2026-11-15');
    expect(paused.pausedFrom).toBe('2026-11-01');
    let events = await tdb.db.select().from(outboxEvent).where(eq(outboxEvent.aggregateId, s.id));
    const pausedEvent = events.find((e) => e.eventType === 'series.paused')!;
    expect((pausedEvent.payload['lessonIds'] as string[]).length).toBe(2); // 6.11 and 13.11 are cancelled (T-18)
    expect(await repo.scheduledInstanceIds(s.id, utc('2026-01-01T00:00:00Z'))).toHaveLength(8);
    const cancelledEvents = await tdb.db
      .select()
      .from(outboxEvent)
      .where(eq(outboxEvent.eventType, 'lesson.cancelled'));
    expect(cancelledEvents.length).toBeGreaterThanOrEqual(2);
    expect(cancelledEvents[0]!.payload).toMatchObject({
      reason: 'series_paused',
      byRole: 'SYSTEM',
      kind: 'system',
    }); // M4-06: recorded as a system cancellation by the teacher
    // resume fills the gap again without false conflicts against the surviving instances
    const resumed = await series.resume(t, s.id);
    expect(resumed.pausedFrom).toBeNull();
    expect(await repo.scheduledInstanceIds(s.id, utc('2026-01-01T00:00:00Z'))).toHaveLength(10);
    const reports = await tdb.db
      .select()
      .from(outboxEvent)
      .where(eq(outboxEvent.eventType, 'series.materialized'));
    expect(reports.filter((e) => e.aggregateId === s.id)).toHaveLength(0);
    await series.pause(t, s.id, '2026-11-01', '2026-11-15');

    const split = await series.changeFollowing(t, s.id, '2026-12-01', { startMin: 11 * 60 });
    expect(split.ended.status).toBe('ended');
    expect(split.ended.endsOn).toBe('2026-11-30');
    expect(split.next).toMatchObject({
      startLocal: '11:00:00',
      startsOn: '2026-12-01',
      endsOn: '2026-12-31',
    });
    expect(split.report.created).toBe(4); // December Fridays at 11:00; the 10:00 ones were cancelled by the split
    events = await tdb.db.select().from(outboxEvent).where(eq(outboxEvent.aggregateId, s.id));
    const splitEvent = events.find((e) => e.eventType === 'series.split')!;
    expect((splitEvent.payload['lessonIds'] as string[]).length).toBe(4); // 4.12 … 25.12
    expect(await repo.scheduledInstanceIds(s.id, utc('2026-12-01T00:00:00Z'))).toHaveLength(0);
    await expect(series.changeFollowing(t, split.next.id, '2026-10-01', {})).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(
      series.changeFollowing(t, split.next.id, '2026-12-10', { startMin: 2000 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const other0 = (await createAccount(tdb.txm, { roles: ['TEACHER'] })).id;
    await expect(series.end(asTeacher(other0), split.next.id, '2026-12-15')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const ended = await series.end(t, split.next.id, '2026-12-15');
    expect(ended.endsOn).toBe('2026-12-14');
    expect(await repo.scheduledInstanceIds(split.next.id, utc('2026-12-15T00:00:00Z'))).toHaveLength(0);
    await expect(series.end(t, split.next.id, '2026-12-15')).rejects.toMatchObject({ code: 'CONFLICT' });
    const other = (await createAccount(tdb.txm, { roles: ['TEACHER'] })).id;
    await expect(series.get(asTeacher(other), s.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      series.create(asTeacher(other), {
        target: { studentId },
        weekdays: [1],
        startMin: 600,
        durationMin: 60,
        startsOn: '2026-10-19',
      }),
    ).rejects.toMatchObject({ code: 'LINK_NOT_ACTIVE' });
    await expect(
      series.create(t, {
        target: { studentId },
        weekdays: [9],
        startMin: 600,
        durationMin: 60,
        startsOn: '2026-10-19',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('a biweekly split keeps INTERVAL and the week phase; a broken series does not block the worker pass', async () => {
    const t = asTeacher(teacherId);
    const { series: bi } = await series.create(t, {
      target: { studentId },
      weekdays: [6],
      intervalWeeks: 2,
      startMin: 12 * 60,
      durationMin: 60,
      startsOn: '2026-10-24',
    });
    const repo = ctx.get(SeriesRepository);
    expect(await repo.scheduledInstanceIds(bi.id, utc('2026-01-01T00:00:00Z'))).toHaveLength(6); // 24.10 … 2.01
    // split in an off week (31.10 is off phase): the tail starts with 7.11 at 13:00, still every second week
    const { next } = await series.changeFollowing(t, bi.id, '2026-10-30', { startMin: 13 * 60 });
    expect(next.rrule).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=SA');
    expect(next.startsOn).toBe('2026-11-02'); // Monday of the next on-phase week
    const tail = await tdb.db.select().from(lessonTable).where(eq(lessonTable.seriesId, next.id));
    expect(tail.map((l) => l.startsAt.toISOString().slice(0, 13)).sort()).toEqual([
      '2026-11-07T10',
      '2026-11-21T10',
      '2026-12-05T10',
      '2026-12-19T10',
      '2027-01-02T10',
    ]);
    // a corrupt rule next to a healthy series: the pass skips it and still processes the rest
    await tdb.db.execute(
      `UPDATE lesson_series SET rrule = 'FREQ=DAILY', status = 'active', materialized_until = NULL WHERE id = '${bi.id}'`,
    );
    await tdb.db.execute(
      `UPDATE lesson_series SET materialized_until = '2026-10-19' WHERE id = '${next.id}'`,
    );
    const countBefore = (await tdb.db.select().from(lessonTable)).length;
    expect(await ctx.get(SeriesMaterializer).run()).toBe(1);
    expect((await tdb.db.select().from(lessonTable)).length).toBe(countBefore); // nothing duplicated for `next`
    expect(await ctx.get(SeriesMaterializer).run()).toBe(0); // idempotent once the horizon is reached
    await tdb.db.execute(`UPDATE lesson_series SET status = 'ended' WHERE id = '${bi.id}'`);
  });

  it('a series whose student left is ended by the materializer and the teacher is told', async () => {
    const masha = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Маша' })).id;
    const link = await linkStudent(ctx, teacherId, masha);
    const { series: s } = await series.create(asTeacher(teacherId), {
      target: { studentId: masha },
      weekdays: [2],
      startMin: 9 * 60,
      durationMin: 60,
      startsOn: '2026-10-20',
    });
    await ctx
      .get(EndLinkUseCase)
      .execute(asTeacher(teacherId), link.id, { reason: 'removed_by_teacher', message: 'пока' });
    ctx.clock.set('2026-11-20T12:00:00Z');
    await ctx.get(SeriesMaterializer).run();
    expect((await ctx.get(SeriesRepository).findById(s.id))!.status).toBe('ended');
    ctx.clock.set('2026-10-19T12:00:00Z');
    await drainOutbox(ctx, tdb);
    const notices = await tdb.db
      .select()
      .from(notification)
      .where(eq(notification.typeCode, 'series.conflicts'));
    expect(notices.some((n) => n.payload['ended'] === 'yes')).toBe(true);
    // the future instances were cancelled with the series (T-18); nothing beyond the old horizon either
    const future = { start: utc('2026-11-20T00:00:00Z'), end: utc('2027-03-01T00:00:00Z') };
    expect(await lessons.listByStudent(masha, future, ['scheduled'])).toHaveLength(0);
    const endedEvents = await tdb.db.select().from(outboxEvent).where(eq(outboxEvent.aggregateId, s.id));
    expect(endedEvents.some((e) => e.eventType === 'series.ended')).toBe(true);
  });
});
