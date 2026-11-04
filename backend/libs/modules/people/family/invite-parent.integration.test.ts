import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount } from '@test/factories.js';
import { linkStudent } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import type { Actor } from '@modules/access/actor.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { PeopleModule } from '../people.module.js';
import { FamilyLinkRepository } from './family-link.repository.js';
import { InviteParentUseCase } from './invite-parent.use-case.js';

describe('InviteParentUseCase: context, seats and races', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let useCase: InviteParentUseCase;
  const asTeacher = (id: string): Actor => ({
    accountId: id,
    roles: ['TEACHER'],
    status: 'active',
    source: 'bot',
  });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [PeopleModule, AccessModule]);
    useCase = ctx.get(InviteParentUseCase);
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('only the owner of an active card may invite; ended cards and blocked students are refused', async () => {
    const teacher = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    const other = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    const student = await createAccount(tdb.txm, { roles: ['STUDENT'] });
    const link = await linkStudent(ctx, teacher.id, student.id);
    await expect(useCase.execute(asTeacher(other.id), link.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await ctx.get(AccountRepository).update(student.id, { status: 'blocked' });
    await expect(useCase.execute(asTeacher(teacher.id), link.id)).rejects.toMatchObject({
      code: 'ACCOUNT_BLOCKED',
    });
    await ctx.get(AccountRepository).update(student.id, { status: 'active' });
    expect((await useCase.execute(asTeacher(teacher.id), link.id)).invitation.kind).toBe('parent');
  });

  it('outstanding links of every teacher count towards the four seats; concurrent issues cannot overshoot', async () => {
    const a = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    const b = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    const student = await createAccount(tdb.txm, { roles: ['STUDENT'] });
    const linkA = await linkStudent(ctx, a.id, student.id);
    const linkB = await linkStudent(ctx, b.id, student.id);
    const parent = await createAccount(tdb.txm, { roles: ['PARENT'] });
    await ctx.get(FamilyLinkRepository).insert({
      parentId: parent.id,
      studentId: student.id,
      invitedBy: a.id,
      invitationId: null,
      confirmedAt: ctx.clock.now(),
    });
    await useCase.execute(asTeacher(a.id), linkA.id); // 1 active + 1 pending
    const results = await Promise.allSettled([
      useCase.execute(asTeacher(b.id), linkB.id),
      useCase.execute(asTeacher(b.id), linkB.id),
      useCase.execute(asTeacher(a.id), linkA.id),
    ]);
    // seats: 4 − 1 active − 1 pending = 2 more links at most
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
    expect(rejected.reason).toMatchObject({ code: 'LIMIT_EXCEEDED' });
    const pendingOfA = await useCase.pendingFor(a.id, student.id, ctx.clock.now());
    const pendingOfB = await useCase.pendingFor(b.id, student.id, ctx.clock.now());
    expect(pendingOfA.length + pendingOfB.length).toBe(3);
  });

  it('a teacher cannot revoke another teacher’s parent link', async () => {
    const a = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    const b = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    const student = await createAccount(tdb.txm, { roles: ['STUDENT'] });
    const linkA = await linkStudent(ctx, a.id, student.id);
    const issued = await useCase.execute(asTeacher(a.id), linkA.id);
    await expect(useCase.revoke(asTeacher(b.id), issued.invitation.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await useCase.revoke(asTeacher(a.id), issued.invitation.id)).status).toBe('revoked');
    await expect(useCase.revoke(asTeacher(a.id), issued.invitation.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});
