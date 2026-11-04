import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOUR_MS } from '@shared/time/clock.js';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { nextTelegramUserId } from '@test/factories.js';
import { AccountRepository } from './account.repository.js';
import { BootstrapSuperAdminService } from './bootstrap-super-admin.service.js';
import { IdentityModule } from './identity.module.js';
import { RedeemStaffInvitationUseCase } from './redeem-staff-invitation.use-case.js';

export const tokenOf = (link: string) => new URL(link).searchParams.get('start')!;
export const tg = (id: number, firstName = 'Анна') => ({ id, firstName, username: `u${id}` });

describe('bootstrap super admin (UC-01, 5.1.1)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [IdentityModule]);
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('issues a one-time AuthBot link bound to the configured Telegram id, idempotently', async () => {
    const seed = ctx.get(BootstrapSuperAdminService);
    const saTelegramId = nextTelegramUserId();

    const first = await seed.seed(saTelegramId);
    expect(first.status).toBe('issued');
    if (first.status !== 'issued') throw new Error('unreachable');
    expect(first.link).toMatch(/^https:\/\/t\.me\/TestAuthBot\?start=[A-Za-z0-9_-]{43}$/);
    expect(first.expiresAt.getTime() - ctx.clock.now().getTime()).toBe(24 * HOUR_MS);

    const again = await seed.seed(saTelegramId);
    expect(again).toMatchObject({ status: 'pending', accountId: first.accountId });

    const redeem = ctx.get(RedeemStaffInvitationUseCase);
    await expect(redeem.execute(tg(nextTelegramUserId()), tokenOf(first.link))).rejects.toMatchObject({
      code: 'INVITATION_NOT_FOR_YOU',
    });

    const result = await redeem.execute(tg(saTelegramId, 'Super'), tokenOf(first.link));
    expect(result).toMatchObject({
      role: 'SUPER_ADMIN',
      isNewAccount: false,
      roleAdded: false,
      requiresOnboarding: true,
    });
    expect(result.account.status).toBe('onboarding');
    expect(await seed.seed(saTelegramId)).toMatchObject({ status: 'onboarding' });

    await ctx.get(AccountRepository).update(first.accountId, { status: 'active' });
    expect(await seed.seed(saTelegramId)).toMatchObject({ status: 'active' });
  });

  it('re-issues the link only when the previous one expired', async () => {
    const seed = ctx.get(BootstrapSuperAdminService);
    // a second platform-level SA cannot exist, so run this on a fresh database state
    const tdb2 = await createTestDatabase();
    const ctx2 = await createTestContext(tdb2, [IdentityModule]);
    try {
      const saTelegramId = nextTelegramUserId();
      const first = await ctx2.get(BootstrapSuperAdminService).seed(saTelegramId);
      ctx2.clock.advance(25 * HOUR_MS);
      const second = await ctx2.get(BootstrapSuperAdminService).seed(saTelegramId);
      expect(second.status).toBe('issued');
      expect(second).not.toMatchObject({ link: (first as { link?: string }).link });
    } finally {
      await ctx2.close();
      await tdb2.drop();
    }
    void seed;
  });
});
