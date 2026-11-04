import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { type Actor, assertActive, isSuperAdmin, primaryRole } from '@modules/access/actor.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { assertCanInvite } from './account.rules.js';
import { InvitationRepository } from './invitation.repository.js';
import { type IssuedInvitation, InvitationService } from './invitation.service.js';
import type { InvitationRow, Role } from './schema.js';

export interface InviteStaffInput {
  role: Extract<Role, 'TEACHER' | 'ADMIN'>;
  /** Bind the link to a chosen Telegram contact (INV-03). */
  targetTelegramUserId?: number | null;
  displayName?: string;
}

/** UC-04 / UC-03: admin invites a teacher; super admin invites an admin (INV-01…05). */
@Injectable()
export class InviteStaffUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly invitations: InvitationService,
    private readonly repo: InvitationRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async execute(actor: Actor, input: InviteStaffInput): Promise<IssuedInvitation> {
    assertActive(actor);
    assertCanInvite(actor, input.role);
    if (input.role === 'ADMIN' && !input.targetTelegramUserId) {
      throw AppError.validation('An admin invitation must be bound to a Telegram user');
    }
    const now = this.clock.now();
    return this.txm.run(async () => {
      const issued = await this.invitations.create(
        {
          kind: input.role === 'ADMIN' ? 'admin' : 'teacher',
          createdBy: actor.accountId,
          targetTelegramUserId: input.targetTelegramUserId ?? null,
          payload: input.displayName ? { displayName: input.displayName } : {},
        },
        now,
      );
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: primaryRole(actor),
        action: 'invitation.created',
        entityType: 'invitation',
        entityId: issued.invitation.id,
        after: { kind: issued.invitation.kind, expiresAt: issued.invitation.expiresAt.toISOString() },
        source: actor.source,
        ip: actor.ip,
      });
      return issued;
    });
  }

  async revoke(actor: Actor, invitationId: string): Promise<InvitationRow> {
    assertActive(actor);
    const now = this.clock.now();
    return this.txm.run(async () => {
      const existing = await this.repo.findById(invitationId);
      if (!existing) throw AppError.notFound('invitation', invitationId);
      const ownsIt = existing.createdBy === actor.accountId;
      if (!ownsIt && !isSuperAdmin(actor))
        throw AppError.forbidden('Only the inviter or the super admin can revoke');
      if (existing.kind === 'admin' && !isSuperAdmin(actor)) throw AppError.forbidden('Only the super admin');
      const row = await this.invitations.revoke(invitationId, actor.accountId, now);
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: primaryRole(actor),
        action: 'invitation.revoked',
        entityType: 'invitation',
        entityId: row.id,
        before: { status: existing.status },
        after: { status: row.status },
        source: actor.source,
        ip: actor.ip,
      });
      return row;
    });
  }

  async listPending(actor: Actor): Promise<InvitationRow[]> {
    assertActive(actor);
    return this.repo.listPendingByCreator(actor.accountId, this.clock.now());
  }
}
