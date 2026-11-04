import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount } from '@test/factories.js';
import { linkStudent, MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import { FeatureAdminUseCase } from '@modules/access/features/feature-admin.use-case.js';
import type { Actor } from '@modules/access/actor.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { CreateLessonUseCase } from '../lessons/create-lesson.use-case.js';
import { PersonalBlockUseCase } from '../occupancy/personal-block.use-case.js';
import { ScheduleModule } from '../schedule.module.js';
import { AvailabilityUseCase } from './availability.use-case.js';
import { OpenSlotsQuery } from './open-slots.query.js';

const asTeacher = (id: string): Actor => ({
  accountId: id,
  roles: ['TEACHER'],
  status: 'active',
  source: 'bot',
});
const asStudent = (id: string): Actor => ({
  accountId: id,
  roles: ['STUDENT'],
  status: 'active',
  source: 'bot',
});
const utc = (iso: string) => new Date(iso);

describe('availability rules, open slots and the CAL-09 marker (M3-03)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let availability: AvailabilityUseCase;
  let slots: OpenSlotsQuery;
  let teacherId: string;
  let studentId: string;
  let strangerId: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    // fixed clock: Monday 2026-10-19 12:00Z; teacher in Minsk (+3)
    ctx = await createTestContext(tdb, [PeopleModule, AccessModule, ScheduleModule]);
    availability = ctx.get(AvailabilityUseCase);
    slots = ctx.get(OpenSlotsQuery);
    teacherId = (await createAccount(tdb.txm, { roles: ['TEACHER'], timezone: 'Europe/Minsk' })).id;
    await ctx.get(TeacherProfileRepository).upsert(teacherId, {
      subjectIds: [MATH_ID],
      defaultDurationMin: 60,
      bufferBeforeMin: 0,
      bufferAfterMin: 15,
      calendarMode: 'closed',
      bookingRules: { minNoticeHours: 12, horizonDays: 21, gridStepMin: 30, durations: [60, 90] },
      onboardedAt: ctx.clock.now(),
    });
    studentId = (await createAccount(tdb.txm, { roles: ['STUDENT'] })).id;
    strangerId = (await createAccount(tdb.txm, { roles: ['STUDENT'] })).id;
    await linkStudent(ctx, teacherId, studentId);
    const admin = await createAccount(tdb.txm, { roles: ['ADMIN'] });
    await ctx
      .get(FeatureAdminUseCase)
      .setTeacher(
        { accountId: admin.id, roles: ['ADMIN'], status: 'active', source: 'bot' },
        teacherId,
        'calendar.open_booking',
        { enabled: true },
      );
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('rules and exceptions are validated, owned and audited; removal is refused for strangers', async () => {
    const t = asTeacher(teacherId);
    const rules = await availability.addRule(t, { weekdays: [1, 2, 3], startMin: 15 * 60, endMin: 20 * 60 });
    expect(rules).toHaveLength(3);
    await expect(availability.addRule(t, { weekdays: [], startMin: 0, endMin: 60 })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(
      availability.addRule(t, { weekdays: [1], startMin: 600, endMin: 600 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(availability.addException(t, { date: '2026-13-01', kind: 'closed' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(availability.addException(t, { date: '2026-10-21', kind: 'extra' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await availability.addException(t, { date: '2026-10-21', kind: 'closed' }); // Wednesday off
    const twice = await availability.addException(t, { date: '2026-10-21', kind: 'closed' }); // a double tap
    expect((await availability.listUpcomingExceptions(t, 'Europe/Minsk')).map((e) => e.id)).toEqual([
      twice.id,
    ]);
    await expect(
      availability.addException(t, { date: '2026-10-21', kind: 'closed', startMin: 600 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(availability.addException(t, { date: '2026-10-18', kind: 'closed' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'past' },
    });
    const other = (await createAccount(tdb.txm, { roles: ['TEACHER'] })).id;
    await expect(availability.removeRule(asTeacher(other), rules[0]!.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      availability.addRule(asStudent(studentId), { weekdays: [1], startMin: 0, endMin: 60 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await availability.listUpcomingExceptions(t, 'Europe/Minsk')).toHaveLength(1);
  });

  it('open slots: minimum notice, horizon, windows, buffers, student busy time; visibility by 5.5.3', async () => {
    const t = asTeacher(teacherId);
    const range = { start: utc('2026-10-19T00:00:00Z'), end: utc('2026-10-26T00:00:00Z') };
    // Mon 19.10 is too soon (12 h notice from 12:00Z), Wed closed, Thu+ have no rules → only Tuesday
    const own = await slots.slots(t, { teacherId, range });
    expect(own.durationMin).toBe(60);
    expect(own.durations).toEqual([60, 90]);
    expect([...new Set(own.slots.map((s) => s.start.toISOString().slice(0, 10)))]).toEqual(['2026-10-20']);
    expect(own.slots[0]!.start.toISOString()).toBe('2026-10-20T12:00:00.000Z'); // 15:00 Minsk
    expect(own.slots.at(-1)!.start.toISOString()).toBe('2026-10-20T16:00:00.000Z'); // 19:00–20:00 is the last hour
    await expect(slots.slots(t, { teacherId, range, durationMin: 45 })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });

    // a lesson 16:00–17:00 Minsk (13:00Z): its 15-minute buffer blocks until 17:15, and a candidate 15:00–16:00
    // would need its own buffer until 16:15 → 15:00…17:00 are gone, 17:30 survives
    const create = ctx.get(CreateLessonUseCase);
    await create.execute(t, {
      target: { studentId },
      startsAt: utc('2026-10-20T13:00:00Z'),
      durationMin: 60,
    });
    const after = await slots.slots(t, { teacherId, range });
    expect(after.slots.map((s) => s.start.toISOString().slice(11, 16))).toEqual([
      '14:30',
      '15:00',
      '15:30',
      '16:00',
    ]);
    // the student's own lesson at another teacher (18:00–19:00 Minsk) takes 17:30 and 18:00 away too
    const otherTeacher = (await createAccount(tdb.txm, { roles: ['TEACHER'], timezone: 'Europe/Minsk' })).id;
    await ctx
      .get(TeacherProfileRepository)
      .upsert(otherTeacher, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now() });
    await linkStudent(ctx, otherTeacher, studentId);
    await create.execute(asTeacher(otherTeacher), {
      target: { studentId },
      startsAt: utc('2026-10-20T15:00:00Z'),
      durationMin: 60,
    });
    const forStudent = await slots.slots(t, { teacherId, studentId, range });
    expect(forStudent.slots.map((s) => s.start.toISOString().slice(11, 16))).toEqual(['16:00']);

    // visibility: closed → refused; open_all → allowed; card override → closed again; strangers → not found
    await expect(slots.slots(asStudent(studentId), { teacherId, range })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'calendar_closed' },
    });
    await ctx.get(TeacherProfileRepository).upsert(teacherId, { calendarMode: 'open_all' });
    expect((await slots.slots(asStudent(studentId), { teacherId, range })).slots).toHaveLength(1);
    const link = (await ctx.get(TeacherStudentRepository).findByPair(teacherId, studentId))!;
    await ctx.get(TeacherStudentRepository).update(link.id, { calendarOpen: false });
    await expect(slots.slots(asStudent(studentId), { teacherId, range })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // open_selected: only the card override opens it; closed beats any override; a disabled feature closes all
    await ctx.get(TeacherProfileRepository).upsert(teacherId, { calendarMode: 'open_selected' });
    await expect(slots.slots(asStudent(studentId), { teacherId, range })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await ctx.get(TeacherStudentRepository).update(link.id, { calendarOpen: true });
    expect((await slots.slots(asStudent(studentId), { teacherId, range })).slots).toHaveLength(1);
    await ctx.get(TeacherProfileRepository).upsert(teacherId, { calendarMode: 'closed' });
    await expect(slots.slots(asStudent(studentId), { teacherId, range })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await ctx.get(TeacherProfileRepository).upsert(teacherId, { calendarMode: 'open_all' });
    const admin2 = await createAccount(tdb.txm, { roles: ['ADMIN'] });
    await ctx
      .get(FeatureAdminUseCase)
      .setTeacher(
        { accountId: admin2.id, roles: ['ADMIN'], status: 'active', source: 'bot' },
        teacherId,
        'calendar.open_booking',
        { enabled: false },
      );
    await expect(slots.slots(asStudent(studentId), { teacherId, range })).rejects.toMatchObject({
      code: 'FEATURE_DISABLED',
    });
    expect((await slots.slots(t, { teacherId, studentId, range })).slots).toHaveLength(1); // the teacher still sees them
    await ctx
      .get(FeatureAdminUseCase)
      .setTeacher(
        { accountId: admin2.id, roles: ['ADMIN'], status: 'active', source: 'bot' },
        teacherId,
        'calendar.open_booking',
        { enabled: true },
      );
    await ctx.get(TeacherStudentRepository).update(link.id, { calendarOpen: false });
    await expect(slots.slots(asStudent(studentId), { teacherId, range })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(slots.slots(asStudent(strangerId), { teacherId, range })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(slots.slots(t, { teacherId, studentId: strangerId, range })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(slots.slots(asTeacher(otherTeacher), { teacherId, range })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const tooLong = { start: range.start, end: utc('2026-12-01T00:00:00Z') };
    await expect(slots.slots(t, { teacherId, range: tooLong })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('a lesson outside the windows is created but marked (CAL-09); blocks take time away from slots', async () => {
    const t = asTeacher(teacherId);
    const create = ctx.get(CreateLessonUseCase);
    // Thu 22.10 11:00 Minsk: no rule that day
    const outside = await create.execute(t, {
      target: { studentId },
      startsAt: utc('2026-10-22T08:00:00Z'),
      durationMin: 60,
    });
    expect(outside.lesson.outsideWindows).toBe(true);
    // Tue 27.10 15:00 Minsk: inside the Tuesday rule
    const inside = await create.execute(t, {
      target: { studentId },
      startsAt: utc('2026-10-27T12:00:00Z'),
      durationMin: 60,
    });
    expect(inside.lesson.outsideWindows).toBe(false);
    await ctx
      .get(PersonalBlockUseCase)
      .create(t, { during: { start: utc('2026-10-27T13:30:00Z'), end: utc('2026-10-27T17:00:00Z') } });
    const day = { start: utc('2026-10-27T00:00:00Z'), end: utc('2026-10-28T00:00:00Z') };
    expect((await slots.slots(t, { teacherId, range: day })).slots).toEqual([]); // lesson + buffer, then the block until 20:00
  });
});
