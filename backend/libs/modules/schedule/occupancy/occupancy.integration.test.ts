import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount } from '@test/factories.js';
import { linkStudent } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import type { Actor } from '@modules/access/actor.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { ScheduleModule } from '../schedule.module.js';
import { occupancy } from '../schema.js';
import { BusyQuery } from './busy.query.js';
import { OccupancyService } from './occupancy.service.js';
import { PersonalBlockUseCase } from './personal-block.use-case.js';

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 21, h, m));
const asTeacher = (id: string): Actor => ({
  accountId: id,
  roles: ['TEACHER'],
  status: 'active',
  source: 'bot',
});

describe('occupancy (CAL-01…CAL-04, 7.5): exclusion constraint, buffers, blocks, busy visibility', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let service: OccupancyService;
  let teacherId: string;
  let studentId: string;
  let blockId: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [PeopleModule, AccessModule, ScheduleModule]);
    service = ctx.get(OccupancyService);
    teacherId = (await createAccount(tdb.txm, { roles: ['TEACHER'] })).id;
    studentId = (await createAccount(tdb.txm, { roles: ['STUDENT'] })).id;
    await linkStudent(ctx, teacherId, studentId);
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('a block records exactly the busy time; the race between two parallel blocks is decided by the DB', async () => {
    const blocks = ctx.get(PersonalBlockUseCase);
    const results = await Promise.allSettled([
      blocks.create(asTeacher(teacherId), { during: { start: at(10), end: at(11) }, title: 'врач' }),
      blocks.create(asTeacher(teacherId), { during: { start: at(10, 30), end: at(12) } }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toMatchObject({ code: 'LESSON_CONFLICT' });
    blockId = ok[0]!.value.id;
    const rows = await tdb.db.select().from(occupancy).where(eq(occupancy.accountId, teacherId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'block', blockId, isActive: true, bufferBeforeMin: 0 });
    // the failed transaction left no block row behind either
    expect(await blocks.listInRange(asTeacher(teacherId), { start: at(0), end: at(23) })).toHaveLength(1);
  });

  it('touching intervals do not conflict (CAL-03); the teacher buffer is stored in the row (CAL-04)', async () => {
    const lessonId = '019a0000-0000-7000-8000-00000000aaaa';
    await tdb.db.execute(
      `INSERT INTO lesson (id, teacher_id, starts_at, ends_at) VALUES ('${lessonId}', '${teacherId}', '2026-10-21T12:00:00Z', '2026-10-21T13:00:00Z')`,
    );
    const [teacherRow] = await tdb.txm.run(() =>
      service.reserve({
        source: { kind: 'lesson', lessonId },
        during: { start: at(12), end: at(13) }, // touches the block that may end at 11 or 12: fine either way
        teacher: { accountId: teacherId, bufferBeforeMin: 0, bufferAfterMin: 10 },
        studentIds: [studentId],
      }),
    );
    expect(teacherRow).toMatchObject({ bufferAfterMin: 10 });
    expect(teacherRow!.during).toEqual({ start: at(12), end: at(13, 10) });
    // the teacher's buffer blocks 13:00–13:10 for the teacher only; the student is free at 13:00
    expect(
      await service.findConflict({
        during: { start: at(13), end: at(14) },
        teacher: { accountId: teacherId, bufferBeforeMin: 0, bufferAfterMin: 0 },
        studentIds: [],
      }),
    ).toEqual({ who: 'teacher' });
    expect(
      await service.findConflict({
        during: { start: at(13, 10), end: at(14) },
        teacher: { accountId: teacherId, bufferBeforeMin: 0, bufferAfterMin: 0 },
        studentIds: [studentId],
      }),
    ).toBeNull();
    const other = (await createAccount(tdb.txm, { roles: ['TEACHER'] })).id;
    // CAL-02: the student's occupancy is visible to another teacher as a student conflict
    expect(
      await service.findConflict({
        during: { start: at(12, 30), end: at(13, 30) },
        teacher: { accountId: other, bufferBeforeMin: 0, bufferAfterMin: 0 },
        studentIds: [studentId],
      }),
    ).toEqual({ who: 'student', studentId });
  });

  it('busy exposes only intervals, merged, and only to entitled actors (CAL-07, 5.5.3)', async () => {
    const busy = ctx.get(BusyQuery);
    const range = { start: at(0), end: at(23) };
    const mine = await busy.busy(asTeacher(teacherId), teacherId, range);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(mine.every((i) => Object.keys(i).sort().join() === 'end,start')).toBe(true);
    const ofStudent = await busy.busy(asTeacher(teacherId), studentId, range);
    expect(ofStudent).toEqual([{ start: at(12), end: at(13) }]);
    const stranger = (await createAccount(tdb.txm, { roles: ['TEACHER'] })).id;
    await expect(busy.busy(asTeacher(stranger), studentId, range)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const student: Actor = { accountId: studentId, roles: ['STUDENT'], status: 'active', source: 'bot' };
    await expect(busy.busy(student, teacherId, range)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await busy.busy(student, studentId, range)).toHaveLength(1);
    await expect(
      busy.busy(student, studentId, { start: at(0), end: new Date(at(0).getTime() + 70 * 864e5) }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('reserveStudent maps a lost race to the student; roles and the past are checked', async () => {
    const lessonId = '019a0000-0000-7000-8000-00000000bbbb';
    await tdb.db.execute(
      `INSERT INTO lesson (id, teacher_id, starts_at, ends_at) VALUES ('${lessonId}', '${teacherId}', '2026-10-21T12:30:00Z', '2026-10-21T13:30:00Z')`,
    );
    await expect(
      tdb.txm.run(() => service.reserveStudent(lessonId, studentId, { start: at(12, 30), end: at(13, 30) })),
    ).rejects.toMatchObject({ code: 'LESSON_CONFLICT', details: { who: 'student', studentId } });
    const blocks = ctx.get(PersonalBlockUseCase);
    const student: Actor = { accountId: studentId, roles: ['STUDENT'], status: 'active', source: 'bot' };
    await expect(blocks.create(student, { during: { start: at(20), end: at(21) } })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      blocks.create(asTeacher(teacherId), {
        during: { start: new Date('2026-10-18T10:00:00Z'), end: new Date('2026-10-18T11:00:00Z') },
        title: 'past',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { reason: 'past' } });
    const admin: Actor = { accountId: teacherId, roles: ['ADMIN'], status: 'active', source: 'bot' };
    expect((await ctx.get(BusyQuery).busy(admin, studentId, { start: at(0), end: at(23) })).length).toBe(1);
  });

  it('removing a block frees the time; a second removal and a foreign block are refused', async () => {
    const blocks = ctx.get(PersonalBlockUseCase);
    const other = (await createAccount(tdb.txm, { roles: ['TEACHER'] })).id;
    await expect(blocks.remove(asTeacher(other), blockId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await blocks.remove(asTeacher(teacherId), blockId);
    await expect(blocks.remove(asTeacher(teacherId), blockId)).rejects.toMatchObject({ code: 'CONFLICT' });
    const again = await blocks.create(asTeacher(teacherId), { during: { start: at(10), end: at(11) } });
    expect(again.id).not.toBe(blockId);
  });
});
