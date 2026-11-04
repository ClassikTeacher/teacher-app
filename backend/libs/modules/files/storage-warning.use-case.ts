import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';

/** UC-27: when a student's upload hits the teacher's quota, the teacher gets a warning (once a day per teacher). */
@Injectable()
export class StorageWarningUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly outbox: OutboxService,
  ) {}

  async notifyFull(teacherId: string): Promise<void> {
    await this.txm.run(() =>
      this.outbox.publish({
        type: 'storage.full',
        aggregateType: 'account',
        aggregateId: teacherId,
        payload: { teacherId },
      }),
    );
  }
}
