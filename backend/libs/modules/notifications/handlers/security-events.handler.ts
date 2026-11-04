import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { type DeliveredEvent, DomainEventBus } from '@modules/outbox/event-bus.js';
import { NotificationService } from '../notification.service.js';
import { NotificationRenderer } from '../render.js';
import { BUTTONS_PAYLOAD_KEY } from '../types.js';

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const transferEvent = z.object({
  transferId: z.string().uuid(),
  fromAccountId: z.string().uuid(),
  toAccountId: z.string().uuid(),
});

/** Security messages go to AuthBot (5.13.1 "staff-безопасность — AuthBot"): the super admin transfer (UC-02). */
@Injectable()
export class SecurityEventsHandler implements OnModuleInit {
  private readonly labels = new NotificationRenderer();

  constructor(
    private readonly bus: DomainEventBus,
    private readonly accounts: AccountRepository,
    private readonly notifications: NotificationService,
  ) {}

  onModuleInit(): void {
    this.bus.on('superadmin.transfer_requested', (e) => this.requested(e));
    this.bus.on('superadmin.transfer_confirmed', (e) => this.decided(e, 'confirmed'));
    this.bus.on('superadmin.transfer_declined', (e) => this.decided(e, 'declined'));
    this.bus.on('superadmin.transfer_cancelled', (e) => this.decided(e, 'cancelled'));
  }

  private parse(event: DeliveredEvent): z.infer<typeof transferEvent> {
    const result = transferEvent.safeParse(event.payload);
    if (!result.success) throw new UnrecoverableError(`malformed ${event.type} payload`);
    return result.data;
  }

  private async nameOf(accountId: string): Promise<string> {
    const a = await this.accounts.findById(accountId);
    return a ? esc(`${a.firstName} ${a.lastName}`.trim() || a.username || accountId) : accountId;
  }

  private async requested(event: DeliveredEvent): Promise<void> {
    const { transferId, fromAccountId, toAccountId } = this.parse(event);
    const from = await this.nameOf(fromAccountId);
    await this.notifications.schedule({
      type: 'security.sa_transfer_requested',
      recipientId: toAccountId,
      bot: 'auth',
      payload: {
        from,
        [BUTTONS_PAYLOAD_KEY]: [
          { text: this.labels.t('btn-sat-confirm'), data: `m:sat:confirm:${transferId}` },
          { text: this.labels.t('btn-sat-decline'), data: `m:sat:decline:${transferId}` },
        ],
      },
      dedupeKey: `security.sa_transfer_requested:${event.id}:to`,
    });
    await this.notifications.schedule({
      type: 'security.sa_transfer_requested',
      recipientId: fromAccountId,
      bot: 'auth',
      payload: { from, to: await this.nameOf(toAccountId), [BUTTONS_PAYLOAD_KEY]: [] },
      dedupeKey: `security.sa_transfer_requested:${event.id}:from`,
    });
  }

  private async decided(
    event: DeliveredEvent,
    decision: 'confirmed' | 'declined' | 'cancelled',
  ): Promise<void> {
    const { fromAccountId, toAccountId } = this.parse(event);
    const payload = { from: await this.nameOf(fromAccountId), to: await this.nameOf(toAccountId) };
    for (const recipientId of [fromAccountId, toAccountId]) {
      await this.notifications.schedule({
        type: `security.sa_transfer_${decision}`,
        recipientId,
        bot: 'auth',
        payload,
        dedupeKey: `security.sa_transfer_${decision}:${event.id}:${recipientId}`,
      });
    }
  }
}
