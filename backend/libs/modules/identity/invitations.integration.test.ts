import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '@shared/errors/app-error.js';
import { HOUR_MS } from '@shared/time/clock.js';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount, nextTelegramUserId } from '@test/factories.js';
import type { Actor } from '@modules/access/actor.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { AccountRepository } from './account.repository.js';
import { IdentityModule } from './identity.module.js';
import { InviteStaffUseCase } from './invite-staff.use-case.js';
import { RedeemStaffInvitationUseCase } from './redeem-staff-invitation.use-case.js';

const tg = (id: number, firstName = 'Анна') => ({ id, firstName, username: `u${id}` });

describe('staff invitations (UC-04, INV-01…05)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let admin: Actor;
  let sa: Actor;
  let teacher: Actor;

  const actorOf = async (roles: Actor['roles']): Promise<Actor> => {
    const row = await createAccount(tdb.txm, { roles: [...roles] });
    return { accountId: row.id, roles, status: 'active', source: 'bot' };
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [IdentityModule]);
    sa = await actorOf(['SUPER_ADMIN']);
    admin = await actorOf(['ADMIN']);
    teacher = await actorOf(['TEACHER']);
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('admin invites a teacher; the link is one-time and creates an onboarding account with the role', async () => {
    const invite = ctx.get(InviteStaffUseCase);
    const redeem = ctx.get(RedeemStaffInvitationUseCase);
    const issued = await invite.execute(admin, { role: 'TEACHER', displayName: 'Анна П.' });
    expect(issued.link).toContain('t.me/TestAuthBot?start=');
    expect(issued.invitation.tokenHash).not.toContain(issued.token);
    expect(issued.invitation.expiresAt.getTime() - ctx.clock.now().getTime()).toBe(72 * HOUR_MS);

    const newUser = tg(nextTelegramUserId());
    expect((await redeem.peek(issued.token, newUser.id))?.check).toEqual({ ok: true });

    const result = await redeem.execute(newUser, issued.token);
    expect(result).toMatchObject({
      role: 'TEACHER',
      isNewAccount: true,
      roleAdded: true,
      requiresOnboarding: true,
    });
    expect(result.account.status).toBe('onboarding');
    expect(await ctx.get(AccountRepository).activeRoles(result.account.id)).toEqual(['TEACHER']);

    await expect(redeem.execute(tg(nextTelegramUserId()), issued.token)).rejects.toMatchObject({
      code: 'INVITATION_INVALID',
      details: { reason: 'used' },
    });
    const audit = await ctx.get(AuditService).query({ entityId: issued.invitation.id, page: 1, limit: 10 });
    expect(audit.items.map((a) => a.action).sort()).toEqual(['invitation.created', 'invitation.redeemed']);
  });

  it('adds the TEACHER role to an existing account instead of creating a new one (INV-04)', async () => {
    const parentTelegramId = nextTelegramUserId();
    const parent = await createAccount(tdb.txm, { telegramUserId: parentTelegramId, roles: ['PARENT'] });
    const issued = await ctx.get(InviteStaffUseCase).execute(admin, { role: 'TEACHER' });
    const result = await ctx.get(RedeemStaffInvitationUseCase).execute(tg(parentTelegramId), issued.token);
    expect(result.account.id).toBe(parent.id);
    expect(result).toMatchObject({ isNewAccount: false, roleAdded: true, requiresOnboarding: true });
    expect((await ctx.get(AccountRepository).activeRoles(parent.id)).sort()).toEqual(['PARENT', 'TEACHER']);
  });

  it('enforces who may invite whom (INV-01)', async () => {
    const invite = ctx.get(InviteStaffUseCase);
    await expect(invite.execute(teacher, { role: 'TEACHER' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(invite.execute(admin, { role: 'ADMIN' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(invite.execute(sa, { role: 'ADMIN' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const bound = await invite.execute(sa, { role: 'ADMIN', targetTelegramUserId: nextTelegramUserId() });
    expect(bound.invitation.kind).toBe('admin');
  });

  it('rejects a bound link opened by someone else and an expired link (INV-02, INV-03)', async () => {
    const invite = ctx.get(InviteStaffUseCase);
    const redeem = ctx.get(RedeemStaffInvitationUseCase);
    const bound = await invite.execute(admin, {
      role: 'TEACHER',
      targetTelegramUserId: nextTelegramUserId(),
    });
    await expect(redeem.execute(tg(nextTelegramUserId()), bound.token)).rejects.toMatchObject({
      code: 'INVITATION_NOT_FOR_YOU',
    });
    const expiring = await invite.execute(admin, { role: 'TEACHER' });
    ctx.clock.advance(72 * HOUR_MS);
    await expect(redeem.execute(tg(nextTelegramUserId()), expiring.token)).rejects.toMatchObject({
      code: 'INVITATION_INVALID',
      details: { reason: 'expired' },
    });
    ctx.clock.advance(-72 * HOUR_MS);
  });

  it('lets exactly one of two concurrent redeems win (row lock)', async () => {
    const issued = await ctx.get(InviteStaffUseCase).execute(admin, { role: 'TEACHER' });
    const redeem = ctx.get(RedeemStaffInvitationUseCase);
    const results = await Promise.allSettled([
      redeem.execute(tg(nextTelegramUserId()), issued.token),
      redeem.execute(tg(nextTelegramUserId()), issued.token),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(AppError.is(rejected[0]!.reason, 'INVITATION_INVALID')).toBe(true);
  });

  it('revocation: the inviter or the super admin, not another admin; revoked links stop working', async () => {
    const invite = ctx.get(InviteStaffUseCase);
    const otherAdmin = await actorOf(['ADMIN']);
    const issued = await invite.execute(admin, { role: 'TEACHER' });
    await expect(invite.revoke(otherAdmin, issued.invitation.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect((await invite.revoke(admin, issued.invitation.id)).status).toBe('revoked');
    await expect(invite.revoke(admin, issued.invitation.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      ctx.get(RedeemStaffInvitationUseCase).execute(tg(nextTelegramUserId()), issued.token),
    ).rejects.toMatchObject({ code: 'INVITATION_INVALID', details: { reason: 'revoked' } });
    const bySa = await invite.execute(admin, { role: 'TEACHER' });
    expect((await invite.revoke(sa, bySa.invitation.id)).status).toBe('revoked');
  });
});

describe('invitation validity follows the inviter authority (INV-01 at redeem time)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let saRow: Awaited<ReturnType<typeof createAccount>>;
  let sa: Actor;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [IdentityModule]);
    saRow = await createAccount(tdb.txm, { roles: ['SUPER_ADMIN'] });
    sa = { accountId: saRow.id, roles: ['SUPER_ADMIN'], status: 'active', source: 'api' };
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('a blocked admin cannot have their pending links redeemed, and they are revoked on block', async () => {
    const adminRow = await createAccount(tdb.txm, { roles: ['ADMIN'] });
    const admin: Actor = { accountId: adminRow.id, roles: ['ADMIN'], status: 'active', source: 'bot' };
    const issued = await ctx.get(InviteStaffUseCase).execute(admin, { role: 'TEACHER' });

    const { BlockAccountUseCase } = await import('./block-account.use-case.js');
    await ctx.get(BlockAccountUseCase).block(sa, adminRow.id, { reason: 'r', lessonsPolicy: 'keep' });

    await expect(
      ctx.get(RedeemStaffInvitationUseCase).execute(tg(nextTelegramUserId()), issued.token),
    ).rejects.toMatchObject({ code: 'INVITATION_INVALID', details: { reason: 'revoked' } });
  });

  it('an admin link must be bound to a Telegram user; it dies when the inviter loses the SA role', async () => {
    const invite = ctx.get(InviteStaffUseCase);
    await expect(invite.execute(sa, { role: 'ADMIN' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const target = nextTelegramUserId();
    const issued = await invite.execute(sa, { role: 'ADMIN', targetTelegramUserId: target });
    await ctx.get(AccountRepository).revokeRole(saRow.id, 'SUPER_ADMIN', null);
    await expect(
      ctx.get(RedeemStaffInvitationUseCase).execute(tg(target), issued.token),
    ).rejects.toMatchObject({
      code: 'INVITATION_INVALID',
      details: { reason: 'inviter_unauthorized' },
    });
  });
});
