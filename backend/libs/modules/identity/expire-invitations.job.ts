import { Injectable, Logger } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { Clock } from '@shared/time/clock.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { InvitationRepository } from './invitation.repository.js';

/** UC-40: pending invitations past `expires_at` become `expired`; each raises `invitation.expired` (admin.* notification). */
@Injectable()
export class ExpireInvitationsJob {
  private readonly logger = new Logger(ExpireInvitationsJob.name);

  constructor(
    private readonly txm: TransactionManager,
    private readonly invitations: InvitationRepository,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  async run(): Promise<number> {
    return this.txm.run(async () => {
      const expired = await this.invitations.expireOverdue(this.clock.now());
      for (const inv of expired) {
        await this.outbox.publish({
          type: 'invitation.expired',
          aggregateType: 'invitation',
          aggregateId: inv.id,
          payload: {
            invitationId: inv.id,
            kind: inv.kind,
            createdBy: inv.createdBy,
            displayName: inv.payload.displayName ?? null,
          },
        });
      }
      if (expired.length > 0) this.logger.log({ count: expired.length }, 'invitations expired');
      return expired.length;
    });
  }
}
