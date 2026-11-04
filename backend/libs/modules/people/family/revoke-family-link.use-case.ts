import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { type Actor, assertActive, isAdmin, primaryRole } from '@modules/access/actor.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import type { FamilyLinkRow } from '../schema.js';
import { FamilyLinkRepository } from './family-link.repository.js';

export type FamilyRevoker = 'parent' | 'teacher' | 'admin';

/** 5.4.3 / 3.8: who may revoke a family link — the parent, the teacher who created it, an admin; never the student. */
export function familyRevokerRole(actor: Actor, link: FamilyLinkRow): FamilyRevoker {
  if (actor.accountId === link.parentId) return 'parent';
  if (isAdmin(actor)) return 'admin';
  if (link.invitedBy === actor.accountId && actor.roles.includes('TEACHER')) return 'teacher';
  throw AppError.forbidden('Only the parent, the inviting teacher or an admin can revoke a family link');
}

@Injectable()
export class RevokeFamilyLinkUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly family: FamilyLinkRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  async execute(actor: Actor, familyLinkId: string): Promise<FamilyLinkRow> {
    assertActive(actor);
    const now = this.clock.now();
    return this.txm.run(async () => {
      const link = await this.family.findById(familyLinkId, { forUpdate: true });
      if (!link) throw AppError.notFound('family link', familyLinkId);
      const by = familyRevokerRole(actor, link);
      const revoked = await this.family.revoke(link.id, actor.accountId, now);
      if (!revoked) throw new AppError('CONFLICT', 'Family link is not active', { status: link.status });
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: by === 'parent' ? 'PARENT' : by === 'teacher' ? 'TEACHER' : primaryRole(actor), // the role acted in (M-4)
        action: 'family.revoked',
        entityType: 'family_link',
        entityId: link.id,
        before: { status: 'active' },
        after: { status: 'revoked', by },
        source: actor.source,
        ip: actor.ip,
      });
      await this.outbox.publish({
        type: 'family.revoked',
        aggregateType: 'family_link',
        aggregateId: link.id,
        payload: {
          familyLinkId: link.id,
          parentId: link.parentId,
          studentId: link.studentId,
          teacherId: link.invitedBy,
          by,
          byAccountId: actor.accountId,
        },
      });
      return revoked;
    });
  }
}
