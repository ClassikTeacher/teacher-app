import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { type Actor, assertSuperAdmin, primaryRole } from '@modules/access/actor.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { AccountRepository } from './account.repository.js';
import { assertCanManageAdminRole } from './account.rules.js';
import { InvitationRepository } from './invitation.repository.js';

/** UC-03: the super admin grants the ADMIN role to an existing teacher or revokes it. */
@Injectable()
export class AdminRoleUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly accounts: AccountRepository,
    private readonly invitations: InvitationRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  async grant(actor: Actor, targetId: string): Promise<void> {
    assertSuperAdmin(actor);
    assertCanManageAdminRole(actor, targetId);
    await this.txm.run(async () => {
      const target = await this.accounts.findById(targetId, { forUpdate: true });
      if (!target) throw AppError.notFound('account', targetId);
      if (target.status !== 'active')
        throw new AppError('CONFLICT', 'Only active accounts can become admins');
      const roles = await this.accounts.activeRoles(target.id);
      if (roles.includes('ADMIN')) throw new AppError('CONFLICT', 'Account is already an admin');
      // 3.3 / INV-01: an existing *teacher* gets the role; anyone else is invited with role ADMIN instead.
      if (!roles.includes('TEACHER'))
        throw new AppError('CONFLICT', 'Only an existing teacher can be made admin');
      await this.accounts.grantRole(target.id, 'ADMIN', actor.accountId);
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: primaryRole(actor),
        action: 'role.granted',
        entityType: 'account',
        entityId: target.id,
        after: { role: 'ADMIN' },
        source: actor.source,
        ip: actor.ip,
      });
      await this.outbox.publish({
        type: 'role.granted',
        aggregateType: 'account',
        aggregateId: target.id,
        payload: { accountId: target.id, role: 'ADMIN', byAccountId: actor.accountId },
      });
    });
  }

  async revoke(actor: Actor, targetId: string): Promise<void> {
    assertSuperAdmin(actor);
    assertCanManageAdminRole(actor, targetId);
    const now = this.clock.now();
    await this.txm.run(async () => {
      const target = await this.accounts.findById(targetId, { forUpdate: true });
      if (!target) throw AppError.notFound('account', targetId);
      const revoked = await this.accounts.revokeRole(targetId, 'ADMIN', actor.accountId);
      if (!revoked) throw new AppError('CONFLICT', 'Account is not an admin');
      // Links issued with admin authority must stop working once the role is gone (INV-01).
      const revokedInvitations = await this.invitations.revokeAllByCreator(targetId, actor.accountId, now);
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: primaryRole(actor),
        action: 'role.revoked',
        entityType: 'account',
        entityId: targetId,
        before: { role: 'ADMIN' },
        after: { revokedInvitations },
        source: actor.source,
        ip: actor.ip,
      });
      await this.outbox.publish({
        type: 'role.revoked',
        aggregateType: 'account',
        aggregateId: targetId,
        payload: { accountId: targetId, role: 'ADMIN', byAccountId: actor.accountId },
      });
    });
  }
}
