import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { AccountRepository } from './account.repository.js';
import { InvitationService, type PeekedInvitation } from './invitation.service.js';
import { STAFF_INVITATION_ROLE } from './invitation.rules.js';
import { inviterStillAuthorized } from './account.rules.js';
import type { AccountRow, Role } from './schema.js';

export interface TelegramIdentity {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
}

export interface RedeemResult {
  account: AccountRow;
  role: Role;
  isNewAccount: boolean;
  roleAdded: boolean;
  /** True when the person still has to fill in the onboarding questionnaire (5.1.2). */
  requiresOnboarding: boolean;
  invitedBy: string | null;
}

/**
 * UC-05 step 1: `/start <token>` in AuthBot. Consumes the invitation, creates the account on first contact
 * (or adds the role to an existing one, INV-04) and leaves the account in `onboarding` until the questionnaire
 * is completed (CompleteStaffOnboardingUseCase, M1-04).
 */
@Injectable()
export class RedeemStaffInvitationUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly invitations: InvitationService,
    private readonly accounts: AccountRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  /** Shows what the link is before consuming it (role, who invited, validity). */
  async peek(token: string, telegramUserId: number): Promise<PeekedInvitation | null> {
    const peeked = await this.invitations.peek(token, telegramUserId, this.clock.now());
    if (!peeked || !STAFF_INVITATION_ROLE[peeked.kind]) return null;
    return peeked;
  }

  /** INV-01 holds at redeem time too: a blocked inviter or one who lost the role invalidates the link. */
  private async assertInviterAuthorized(createdBy: string | null, role: Role): Promise<void> {
    if (createdBy === null) return; // bootstrap
    const inviter = await this.accounts.findById(createdBy);
    const inviterRoles = inviter ? await this.accounts.activeRoles(inviter.id) : [];
    if (!inviter || !inviterStillAuthorized(inviter.status, inviterRoles, role)) {
      throw new AppError('INVITATION_INVALID', 'Invitation is not valid', { reason: 'inviter_unauthorized' });
    }
  }

  async execute(user: TelegramIdentity, token: string): Promise<RedeemResult> {
    const now = this.clock.now();
    return this.txm.run(async () => {
      let account = await this.accounts.findByTelegramUserId(user.id);
      if (account?.status === 'blocked') throw new AppError('ACCOUNT_BLOCKED', 'Account is blocked');

      let isNewAccount = false;
      if (!account) {
        const first = await this.accounts.insertOrGetByTelegramUserId({
          telegramUserId: user.id,
          firstName: user.firstName,
          lastName: user.lastName ?? '',
          username: user.username ?? null,
          status: 'onboarding',
        });
        account = first.row;
        isNewAccount = first.created;
      }

      const inv = await this.invitations.redeem(token, user.id, account.id, now);
      const role = STAFF_INVITATION_ROLE[inv.kind];
      if (!role) throw new AppError('INVITATION_INVALID', 'This link is not a staff invitation');
      await this.assertInviterAuthorized(inv.createdBy, role);

      // Telegram usernames change: refresh on every contact (3.1); a seeded SA moves on to onboarding.
      account = await this.accounts.update(account.id, {
        username: user.username ?? null,
        ...(account.status === 'invited' ? { status: 'onboarding' as const } : {}),
      });

      const roles = await this.accounts.activeRoles(account.id);
      const roleAdded = !roles.includes(role);
      if (roleAdded) {
        await this.accounts.grantRole(account.id, role, inv.createdBy);
        await this.outbox.publish({
          type: 'role.granted',
          aggregateType: 'account',
          aggregateId: account.id,
          payload: { accountId: account.id, role, byAccountId: inv.createdBy },
        });
      }
      await this.audit.record({
        actorId: account.id,
        actorRole: role,
        action: 'invitation.redeemed',
        entityType: 'invitation',
        entityId: inv.id,
        after: { kind: inv.kind, accountId: account.id, roleAdded, isNewAccount },
        source: 'bot',
      });
      return {
        account,
        role,
        isNewAccount,
        roleAdded,
        // A teacher always fills the questionnaire (subjects, default text); other roles only on a fresh account.
        requiresOnboarding: account.status !== 'active' || (role === 'TEACHER' && roleAdded),
        invitedBy: inv.createdBy,
      };
    });
  }
}
