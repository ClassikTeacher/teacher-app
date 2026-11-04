import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount } from '@test/factories.js';
import type { Actor } from '@modules/access/actor.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { outboxEvent } from '@modules/outbox/schema.js';
import { AccountRepository } from './account.repository.js';
import { AdminRoleUseCase } from './admin-role.use-case.js';
import { BlockAccountUseCase } from './block-account.use-case.js';
import { IdentityModule } from './identity.module.js';

describe('block / unblock (UC-08, ACC-01…03) and admin roles (UC-03)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let sa: Actor;
  let admin: Actor;

  const actorOf = async (roles: Actor['roles']): Promise<Actor> => {
    const row = await createAccount(tdb.txm, { roles: [...roles] });
    return { accountId: row.id, roles, status: 'active', source: 'api' };
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [IdentityModule]);
    sa = await actorOf(['SUPER_ADMIN']);
    admin = await actorOf(['ADMIN']);
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('admin blocks a teacher with a reason; audit and outbox event are written in the same transaction', async () => {
    const teacher = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    const uc = ctx.get(BlockAccountUseCase);

    const blocked = await uc.block(admin, teacher.id, {
      reason: 'Нарушение правил',
      lessonsPolicy: 'cancel',
      message: 'Занятия отменены администратором',
    });

    expect(blocked).toMatchObject({
      status: 'blocked',
      priorStatus: 'active',
      blockReason: 'Нарушение правил',
      blockedBy: admin.accountId,
    });
    expect(blocked.blockedAt?.toISOString()).toBe(ctx.clock.now().toISOString());
    const audit = await ctx.get(AuditService).query({ entityId: teacher.id, page: 1, limit: 10 });
    expect(audit.items[0]).toMatchObject({ action: 'account.blocked', actorRole: 'ADMIN', source: 'api' });
    const events = await tdb.db.select().from(outboxEvent).where(eq(outboxEvent.aggregateId, teacher.id));
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      lessonsPolicy: 'cancel',
      message: 'Занятия отменены администратором',
      roles: ['TEACHER'],
    });

    await expect(uc.block(admin, teacher.id, { reason: 'x', lessonsPolicy: 'keep' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('requires a message when future lessons are cancelled (ACC-02) and a reason always', async () => {
    const student = await createAccount(tdb.txm, { roles: ['STUDENT'] });
    const uc = ctx.get(BlockAccountUseCase);
    await expect(uc.block(admin, student.id, { reason: ' ', lessonsPolicy: 'keep' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(uc.block(admin, student.id, { reason: 'r', lessonsPolicy: 'cancel' })).rejects.toMatchObject(
      { code: 'CANCEL_REASON_REQUIRED' },
    );
  });

  it('only the super admin blocks admins; nobody blocks the super admin', async () => {
    const otherAdmin = await createAccount(tdb.txm, { roles: ['ADMIN'] });
    const uc = ctx.get(BlockAccountUseCase);
    await expect(
      uc.block(admin, otherAdmin.id, { reason: 'r', lessonsPolicy: 'keep' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(uc.block(admin, sa.accountId, { reason: 'r', lessonsPolicy: 'keep' })).rejects.toMatchObject(
      { code: 'FORBIDDEN' },
    );
    expect((await uc.block(sa, otherAdmin.id, { reason: 'r', lessonsPolicy: 'keep' })).status).toBe(
      'blocked',
    );
  });

  it('unblock restores the status the account had before (ACC-03)', async () => {
    const onboarding = await createAccount(tdb.txm, { roles: ['TEACHER'], status: 'onboarding' });
    const uc = ctx.get(BlockAccountUseCase);
    await uc.block(admin, onboarding.id, { reason: 'r', lessonsPolicy: 'keep' });
    const restored = await uc.unblock(admin, onboarding.id);
    expect(restored).toMatchObject({
      status: 'onboarding',
      priorStatus: null,
      blockedAt: null,
      blockReason: null,
    });
    await expect(uc.unblock(admin, onboarding.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('a blocked admin actor cannot act; a teacher cannot block anyone', async () => {
    const victim = await createAccount(tdb.txm, { roles: ['STUDENT'] });
    const uc = ctx.get(BlockAccountUseCase);
    const blockedAdmin: Actor = { ...admin, status: 'blocked' };
    await expect(
      uc.block(blockedAdmin, victim.id, { reason: 'r', lessonsPolicy: 'keep' }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_BLOCKED' });
    const teacher = await actorOf(['TEACHER']);
    await expect(uc.block(teacher, victim.id, { reason: 'r', lessonsPolicy: 'keep' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('super admin grants and revokes the ADMIN role of an active teacher; admins cannot', async () => {
    const teacher = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    const student = await createAccount(tdb.txm, { roles: ['STUDENT'] });
    const roles = ctx.get(AdminRoleUseCase);
    const repo = ctx.get(AccountRepository);
    await expect(roles.grant(admin, teacher.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(roles.grant(sa, student.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await roles.grant(sa, teacher.id);
    expect((await repo.activeRoles(teacher.id)).sort()).toEqual(['ADMIN', 'TEACHER']);
    await expect(roles.grant(sa, teacher.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await roles.revoke(sa, teacher.id);
    expect(await repo.activeRoles(teacher.id)).toEqual(['TEACHER']);
    await expect(roles.revoke(sa, teacher.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(roles.revoke(sa, sa.accountId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
