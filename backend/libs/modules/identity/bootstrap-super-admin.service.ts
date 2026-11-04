import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { Clock } from '@shared/time/clock.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { AccountRepository } from './account.repository.js';
import { InvitationRepository } from './invitation.repository.js';
import { InvitationService } from './invitation.service.js';
import { superAdminAccountId } from './super-admin.query.js';

export type BootstrapOutcome =
  | { status: 'active'; accountId: string; telegramUserId: number }
  | { status: 'blocked'; accountId: string }
  | { status: 'onboarding'; accountId: string }
  | { status: 'pending'; accountId: string; expiresAt: Date }
  | { status: 'issued'; accountId: string; link: string; expiresAt: Date };

/**
 * UC-01 / 5.1.1: `seed:superadmin`. Idempotent: an active super admin means nothing to do; a seeded but
 * not yet onboarded one keeps its pending link (re-issued only when the previous one expired).
 */
@Injectable()
export class BootstrapSuperAdminService {
  constructor(
    private readonly txm: TransactionManager,
    private readonly accounts: AccountRepository,
    private readonly invitations: InvitationService,
    private readonly invitationRepo: InvitationRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** `reissue` revokes a still-pending bootstrap link and prints a fresh one (lost link recovery). */
  async seed(telegramUserId: number, options: { reissue?: boolean } = {}): Promise<BootstrapOutcome> {
    const now = this.clock.now();
    return this.txm.run(async () => {
      const existingId = await superAdminAccountId(this.txm.db);
      let account = existingId ? await this.accounts.findById(existingId) : null;
      if (account?.status === 'active') {
        return { status: 'active', accountId: account.id, telegramUserId: account.telegramUserId };
      }
      if (account?.status === 'blocked') return { status: 'blocked', accountId: account.id };
      if (account?.status === 'onboarding') return { status: 'onboarding', accountId: account.id };

      if (!account) {
        account =
          (await this.accounts.findByTelegramUserId(telegramUserId)) ??
          (await this.accounts.insert({ telegramUserId, status: 'invited' }));
        await this.accounts.grantRole(account.id, 'SUPER_ADMIN', null);
      }

      const pending = await this.invitationRepo.findPendingByTarget('bootstrap', account.telegramUserId, now);
      if (pending && !options.reissue) {
        return { status: 'pending', accountId: account.id, expiresAt: pending.expiresAt };
      }
      if (pending) await this.invitations.revoke(pending.id, null, now);

      const issued = await this.invitations.create(
        { kind: 'bootstrap', createdBy: null, targetTelegramUserId: account.telegramUserId },
        now,
      );
      await this.audit.record({
        actorId: null,
        action: 'superadmin.bootstrapped',
        entityType: 'account',
        entityId: account.id,
        after: { invitationId: issued.invitation.id },
        source: 'system',
      });
      return {
        status: 'issued',
        accountId: account.id,
        link: issued.link,
        expiresAt: issued.invitation.expiresAt,
      };
    });
  }
}
