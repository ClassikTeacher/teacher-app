import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { type Actor, assertAdmin, primaryRole } from '@modules/access/actor.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { AccountRepository } from './account.repository.js';
import { InvitationRepository } from './invitation.repository.js';
import { assertCanBlock } from './account.rules.js';
import type { AccountRow } from './schema.js';

export interface BlockInput {
  reason: string;
  /** ACC-02: fate of future lessons of a teacher or student. Applied by scheduling in M4-06. */
  lessonsPolicy: 'cancel' | 'keep';
  /** Required when lessonsPolicy = cancel: the message participants receive. */
  message?: string | null;
}

/** UC-08: block / unblock (ACC-01, ACC-02, ACC-03). Data is never deleted. */
@Injectable()
export class BlockAccountUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly accounts: AccountRepository,
    private readonly invitations: InvitationRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  async block(actor: Actor, targetId: string, input: BlockInput): Promise<AccountRow> {
    assertAdmin(actor);
    const reason = input.reason.trim();
    if (!reason) throw AppError.validation('Block reason is required');
    const message = input.message?.trim() ?? null;
    if (input.lessonsPolicy === 'cancel' && !message) {
      throw new AppError('CANCEL_REASON_REQUIRED', 'A message for cancelled lessons is required');
    }
    const now = this.clock.now();
    return this.txm.run(async () => {
      const target = await this.accounts.findById(targetId, { forUpdate: true });
      if (!target) throw AppError.notFound('account', targetId);
      if (target.status === 'blocked') throw new AppError('CONFLICT', 'Account is already blocked');
      const roles = await this.accounts.activeRoles(target.id);
      assertCanBlock(actor, target, roles);

      const updated = await this.accounts.update(target.id, {
        status: 'blocked',
        priorStatus: target.status,
        blockedAt: now,
        blockedBy: actor.accountId,
        blockReason: reason,
      });
      // Links issued by a blocked inviter must stop working (INV-01 at redeem time).
      const revokedInvitations = await this.invitations.revokeAllByCreator(target.id, actor.accountId, now);
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: primaryRole(actor),
        action: 'account.blocked',
        entityType: 'account',
        entityId: target.id,
        before: { status: target.status },
        after: { status: 'blocked', reason, lessonsPolicy: input.lessonsPolicy, revokedInvitations },
        source: actor.source,
        ip: actor.ip,
      });
      await this.outbox.publish({
        type: 'account.blocked',
        aggregateType: 'account',
        aggregateId: target.id,
        payload: {
          accountId: target.id,
          roles,
          lessonsPolicy: input.lessonsPolicy,
          message,
          byAccountId: actor.accountId,
        },
      });
      return updated;
    });
  }

  async unblock(actor: Actor, targetId: string): Promise<AccountRow> {
    assertAdmin(actor);
    return this.txm.run(async () => {
      const target = await this.accounts.findById(targetId, { forUpdate: true });
      if (!target) throw AppError.notFound('account', targetId);
      if (target.status !== 'blocked') throw new AppError('CONFLICT', 'Account is not blocked');
      const roles = await this.accounts.activeRoles(target.id);
      assertCanBlock(actor, target, roles);

      const updated = await this.accounts.update(target.id, {
        status: target.priorStatus ?? 'active',
        priorStatus: null,
        blockedAt: null,
        blockedBy: null,
        blockReason: null,
      });
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: primaryRole(actor),
        action: 'account.unblocked',
        entityType: 'account',
        entityId: target.id,
        before: { status: 'blocked', reason: target.blockReason },
        after: { status: updated.status },
        source: actor.source,
        ip: actor.ip,
      });
      await this.outbox.publish({
        type: 'account.unblocked',
        aggregateType: 'account',
        aggregateId: target.id,
        payload: { accountId: target.id, byAccountId: actor.accountId },
      });
      return updated;
    });
  }
}
