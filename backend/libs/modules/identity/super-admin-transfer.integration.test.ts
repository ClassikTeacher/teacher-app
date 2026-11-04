import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { HOUR_MS } from '@shared/time/clock.js';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount } from '@test/factories.js';
import { outboxEvent } from '@modules/outbox/schema.js';
import { AccountRepository } from './account.repository.js';
import { IdentityModule } from './identity.module.js';
import { SuperAdminTransferUseCase } from './super-admin-transfer.use-case.js';

describe('UC-02: super admin transfer', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let saId: string;
  let adminId: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [IdentityModule]);
    saId = (await createAccount(tdb.txm, { roles: ['SUPER_ADMIN'] })).id;
    adminId = (await createAccount(tdb.txm, { roles: ['ADMIN', 'TEACHER'] })).id;
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('validates the target, allows one pending transfer, and moves the role on confirmation', async () => {
    const uc = ctx.get(SuperAdminTransferUseCase);
    const repo = ctx.get(AccountRepository);
    const student = (await createAccount(tdb.txm, { roles: ['STUDENT'] })).id;
    await expect(uc.request({ toAccountId: student, previousRole: 'ADMIN' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(uc.request({ toAccountId: saId, previousRole: 'ADMIN' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const transfer = await uc.request({ toAccountId: adminId, previousRole: 'ADMIN', ip: '127.0.0.1' });
    expect(transfer).toMatchObject({ status: 'pending', fromAccountId: saId, toAccountId: adminId });
    await expect(uc.request({ toAccountId: adminId, previousRole: 'NONE' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await uc.findPendingFor(adminId)).toMatchObject({ id: transfer.id });
    expect(await uc.findPendingFor(saId)).toBeNull();

    await expect(uc.confirm(transfer.id, saId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const done = await uc.confirm(transfer.id, adminId);
    expect(done.status).toBe('confirmed');
    expect((await repo.activeRoles(adminId)).sort()).toEqual(['ADMIN', 'SUPER_ADMIN', 'TEACHER']);
    expect((await repo.activeRoles(saId)).sort()).toEqual(['ADMIN']);
    await expect(uc.confirm(transfer.id, adminId)).rejects.toMatchObject({ code: 'CONFLICT' });
    const events = await tdb.db.select().from(outboxEvent).where(eq(outboxEvent.aggregateId, transfer.id));
    expect(events.map((e) => e.eventType)).toEqual([
      'superadmin.transfer_requested',
      'superadmin.transfer_confirmed',
    ]);
  });

  it('declining keeps roles; an expired transfer cannot be confirmed; NONE drops the old role entirely', async () => {
    const uc = ctx.get(SuperAdminTransferUseCase);
    const repo = ctx.get(AccountRepository);
    // adminId is the SA now; saId is a plain admin
    const declined = await uc.request({ toAccountId: saId, previousRole: 'NONE' });
    expect((await uc.decline(declined.id, saId)).status).toBe('declined');
    expect((await repo.activeRoles(adminId)).sort()).toEqual(['ADMIN', 'SUPER_ADMIN', 'TEACHER']);

    const expiring = await uc.request({ toAccountId: saId, previousRole: 'NONE' });
    ctx.clock.advance(25 * HOUR_MS);
    await expect(uc.confirm(expiring.id, saId)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: /expired/,
    });
    expect(await uc.findPendingFor(saId)).toBeNull();

    const fresh = await uc.request({ toAccountId: saId, previousRole: 'NONE' });
    await uc.confirm(fresh.id, saId);
    expect((await repo.activeRoles(saId)).sort()).toEqual(['ADMIN', 'SUPER_ADMIN']);
    // NONE drops only the super admin role; roles the account held on its own are untouched
    expect((await repo.activeRoles(adminId)).sort()).toEqual(['ADMIN', 'TEACHER']);
  });
});

describe('UC-02 review fixes: cancellation, target re-validation, concurrency', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let adminId: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [IdentityModule]);
    await createAccount(tdb.txm, { roles: ['SUPER_ADMIN'] });
    adminId = (await createAccount(tdb.txm, { roles: ['ADMIN'] })).id;
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('a cancelled transfer cannot be confirmed and frees the pending slot', async () => {
    const uc = ctx.get(SuperAdminTransferUseCase);
    const t = await uc.request({ toAccountId: adminId, previousRole: 'ADMIN' });
    expect((await uc.cancel(t.id, { byAccountId: null })).status).toBe('cancelled');
    await expect(uc.confirm(t.id, adminId)).rejects.toMatchObject({ code: 'CONFLICT' });
    const again = await uc.request({ toAccountId: adminId, previousRole: 'ADMIN' });
    expect(again.status).toBe('pending');
    await uc.cancel(again.id, { byAccountId: null });
  });

  it('a target blocked after the request cannot take the role; concurrent requests give one 409', async () => {
    const uc = ctx.get(SuperAdminTransferUseCase);
    const repo = ctx.get(AccountRepository);
    const t = await uc.request({ toAccountId: adminId, previousRole: 'ADMIN' });
    await repo.update(adminId, { status: 'blocked' });
    await expect(uc.confirm(t.id, adminId)).rejects.toMatchObject({ code: 'CONFLICT' });
    await repo.update(adminId, { status: 'active' });
    await uc.cancel(t.id, { byAccountId: null });

    const results = await Promise.allSettled([
      uc.request({ toAccountId: adminId, previousRole: 'ADMIN' }),
      uc.request({ toAccountId: adminId, previousRole: 'ADMIN' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ code: 'CONFLICT' });
  });
});
