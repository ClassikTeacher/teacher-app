import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount } from '@test/factories.js';
import { linkStudent, MATH_ID, PHYSICS_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import type { Actor } from '@modules/access/actor.js';
import { auditLog } from '@modules/audit/schema.js';
import { JournalsPort } from '../journals.port.js';
import { PeopleModule } from '../people.module.js';
import { StudentProfileRepository } from '../student-profile.repository.js';
import { TeacherStudentRepository } from './teacher-student.repository.js';
import { UpdateStudentCardUseCase } from './update-student-card.use-case.js';

describe('UpdateStudentCardUseCase: ownership, shared profile, audit, atomic subjects', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let useCase: UpdateStudentCardUseCase;
  let teacher: Actor;
  let linkId: string;
  let studentId: string;
  const asTeacher = (id: string): Actor => ({
    accountId: id,
    roles: ['TEACHER'],
    status: 'active',
    source: 'bot',
  });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [PeopleModule, AccessModule]);
    useCase = ctx.get(UpdateStudentCardUseCase);
    const t = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    teacher = asTeacher(t.id);
    const s = await createAccount(tdb.txm, { roles: ['STUDENT'] });
    studentId = s.id;
    linkId = (await linkStudent(ctx, t.id, s.id)).id;
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('refuses other teachers and ended cards; records values but not private texts in the audit', async () => {
    const other = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    await expect(useCase.execute(asTeacher(other.id), linkId, { alias: 'x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    await useCase.execute(teacher, linkId, {
      notes: 'очень личная заметка',
      grade: '9',
      maxLessonsPerWeek: 3,
    });
    const rows = await tdb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, linkId), eq(auditLog.action, 'student.card_updated')));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.after)).not.toContain('личная');
    expect(rows[0]!.after).toMatchObject({ notesLength: 20, grade: '9', maxLessonsPerWeek: 3 });
    expect(rows[0]!.before).toMatchObject({ notesLength: 0, grade: null, maxLessonsPerWeek: 2 });
    expect((await ctx.get(StudentProfileRepository).find(studentId))?.grade).toBe('9');

    const links = ctx.get(TeacherStudentRepository);
    await links.update(linkId, {
      status: 'ended',
      endedAt: ctx.clock.now(),
      endReason: 'removed_by_teacher',
    });
    await expect(useCase.execute(teacher, linkId, { alias: 'x' })).rejects.toMatchObject({
      code: 'LINK_NOT_ACTIVE',
    });
    await links.update(linkId, { status: 'active', endedAt: null, endReason: null });
  });

  it('rolls back the profile change when journal provisioning fails', async () => {
    const spy = vi.spyOn(ctx.get(JournalsPort), 'ensureForLink').mockRejectedValueOnce(new Error('boom'));
    await expect(
      useCase.execute(teacher, linkId, { school: 'Гимназия 1', subjectIds: [MATH_ID, PHYSICS_ID] }),
    ).rejects.toThrow('boom');
    spy.mockRestore();
    expect((await ctx.get(StudentProfileRepository).find(studentId))?.school).toBeNull();
    expect((await ctx.get(TeacherStudentRepository).findById(linkId))?.subjectIds).toEqual([MATH_ID]);
  });

  it('toggles subjects atomically under concurrency and never removes the last one', async () => {
    await Promise.all([
      useCase.toggleSubject(teacher, linkId, PHYSICS_ID),
      useCase.toggleSubject(teacher, linkId, '019a0000-0000-7000-8000-000000000003'),
    ]);
    const link = (await ctx.get(TeacherStudentRepository).findById(linkId))!;
    expect(link.subjectIds).toHaveLength(3);
    await useCase.toggleSubject(teacher, linkId, PHYSICS_ID);
    await useCase.toggleSubject(teacher, linkId, '019a0000-0000-7000-8000-000000000003');
    await expect(useCase.toggleSubject(teacher, linkId, MATH_ID)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(
      useCase.execute(teacher, linkId, { subjectIds: ['00000000-0000-7000-8000-000000000000'] }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});
