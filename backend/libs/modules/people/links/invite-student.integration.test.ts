import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount } from '@test/factories.js';
import { MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import type { Actor } from '@modules/access/actor.js';
import { FeatureAdminUseCase } from '@modules/access/features/feature-admin.use-case.js';
import { PeopleModule } from '../people.module.js';
import { InviteStudentUseCase } from './invite-student.use-case.js';
import { TeacherStudentRepository } from './teacher-student.repository.js';

describe('InviteStudentUseCase: seats, ownership, re-issue', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let useCase: InviteStudentUseCase;
  let links: TeacherStudentRepository;
  let admin: Actor;
  const asTeacher = (id: string): Actor => ({
    accountId: id,
    roles: ['TEACHER'],
    status: 'active',
    source: 'bot',
  });
  const input = { subjectIds: [MATH_ID], maxLessonsPerWeek: 2 };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [PeopleModule, AccessModule]);
    useCase = ctx.get(InviteStudentUseCase);
    links = ctx.get(TeacherStudentRepository);
    const adminRow = await createAccount(tdb.txm, { roles: ['ADMIN'] });
    admin = { accountId: adminRow.id, roles: ['ADMIN'], status: 'active', source: 'bot' };
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('two concurrent invitations of a teacher with no cards and maxStudents=1 yield exactly one card', async () => {
    const teacher = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    await ctx.get(FeatureAdminUseCase).setTeacher(admin, teacher.id, 'core', { limits: { maxStudents: 1 } });
    const results = await Promise.allSettled([
      useCase.execute(asTeacher(teacher.id), input),
      useCase.execute(asTeacher(teacher.id), input),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
    expect(failed.reason).toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(await links.countByTeacher(teacher.id, ['pending'])).toBe(1);
  });

  it('no platform limit by default; weekly limit null = no limit; subjects are required', async () => {
    const teacher = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    for (let i = 0; i < 3; i += 1) await useCase.execute(asTeacher(teacher.id), input);
    const { link } = await useCase.execute(asTeacher(teacher.id), {
      subjectIds: [MATH_ID],
      maxLessonsPerWeek: null,
    });
    expect(link.maxLessonsPerWeek).toBeNull();
    expect(await links.countByTeacher(teacher.id, ['pending'])).toBe(4);
    await expect(
      useCase.execute(asTeacher(teacher.id), { subjectIds: [], maxLessonsPerWeek: 2 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('another teacher cannot revoke or re-issue a foreign card', async () => {
    const owner = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    const other = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    const { link } = await useCase.execute(asTeacher(owner.id), input);
    await expect(useCase.revokePending(asTeacher(other.id), link.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(useCase.reissue(asTeacher(other.id), link.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await links.findById(link.id))?.status).toBe('pending');
  });

  it('re-issuing a declined card checks the seat limit; a cancelled card is final', async () => {
    const teacher = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    const declined = await useCase.execute(asTeacher(teacher.id), input);
    await links.update(declined.link.id, { status: 'declined' });
    const occupying = await useCase.execute(asTeacher(teacher.id), input);
    await ctx.get(FeatureAdminUseCase).setTeacher(admin, teacher.id, 'core', { limits: { maxStudents: 1 } });
    await expect(useCase.reissue(asTeacher(teacher.id), declined.link.id)).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
    });
    await useCase.revokePending(asTeacher(teacher.id), occupying.link.id);
    const reissued = await useCase.reissue(asTeacher(teacher.id), declined.link.id);
    expect(reissued.link.status).toBe('pending');
    expect(reissued.issued.invitation.id).not.toBe(declined.issued.invitation.id);
    await expect(useCase.reissue(asTeacher(teacher.id), occupying.link.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});
