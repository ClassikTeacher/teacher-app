import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { type DeliveredEvent, DomainEventBus } from '@modules/outbox/event-bus.js';
import { NotificationService } from '../notification.service.js';

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const teacherOnboarded = z.object({ accountId: z.string().uuid() });
const invitationExpired = z.object({
  createdBy: z.string().uuid().nullable(),
  kind: z.string(),
  displayName: z.string().nullable().optional(),
});
const featureChanged = z.object({ teacherId: z.string().uuid(), feature: z.string(), enabled: z.boolean() });
const roleGranted = z.object({ accountId: z.string().uuid(), role: z.string() });
const accountUnblocked = z.object({ accountId: z.string().uuid() });

/** A malformed payload can never succeed: fail the job without retries instead of looping five times. */
function parse<T>(schema: z.ZodType<T>, event: DeliveredEvent): T {
  const result = schema.safeParse(event.payload);
  if (!result.success)
    throw new UnrecoverableError(`malformed ${event.type} payload: ${result.error.message}`);
  return result.data;
}

/**
 * First consumer of domain events (M1-07): admin-facing messages (`admin.*`), feature changes to teachers,
 * role grants. Every scheduled notification is keyed by the event id, so redelivery is harmless.
 */
@Injectable()
export class AdminEventsHandler implements OnModuleInit {
  constructor(
    private readonly bus: DomainEventBus,
    private readonly txm: TransactionManager,
    private readonly accounts: AccountRepository,
    private readonly notifications: NotificationService,
  ) {}

  onModuleInit(): void {
    this.bus.on('teacher.onboarded', (e) => this.teacherOnboarded(e));
    this.bus.on('invitation.expired', (e) => this.invitationExpired(e));
    this.bus.on('feature.changed', (e) => this.featureChanged(e));
    this.bus.on('role.granted', (e) => this.roleGranted(e));
    this.bus.on('account.unblocked', (e) => this.accountUnblocked(e));
  }

  /** UC-04 step 7: every active admin (and the SA) learns that a teacher joined. */
  private async teacherOnboarded(event: DeliveredEvent): Promise<void> {
    const { accountId } = parse(teacherOnboarded, event);
    await this.txm.run(async () => {
      const teacher = await this.accounts.findById(accountId);
      if (!teacher) return;
      const name = esc(`${teacher.firstName} ${teacher.lastName}`.trim());
      const handle = teacher.username ? ` (@${esc(teacher.username)})` : '';
      const admins = new Map<string, true>();
      for (const role of ['ADMIN', 'SUPER_ADMIN'] as const) {
        for (let page = 1; ; page += 1) {
          const { items, total } = await this.accounts.listByRole(role, { page, limit: 100 });
          for (const a of items) admins.set(a.id, true);
          if (page * 100 >= total || items.length === 0) break;
        }
      }
      for (const adminId of admins.keys()) {
        await this.notifications.schedule({
          type: 'admin.teacher_onboarded',
          recipientId: adminId,
          payload: { name, handle },
          dedupeKey: `admin.teacher_onboarded:${event.id}:${adminId}`,
        });
      }
    });
  }

  private async invitationExpired(event: DeliveredEvent): Promise<void> {
    const { createdBy, kind, displayName } = parse(invitationExpired, event);
    if (!createdBy) return;
    await this.notifications.schedule({
      type: 'admin.invitation_expired',
      recipientId: createdBy,
      payload: { name: esc(displayName ?? '') || '—', kind },
      dedupeKey: `admin.invitation_expired:${event.id}`,
    });
  }

  /** UC-07 step 3: "Вам доступна функция …" / "Функция … отключена администратором". */
  private async featureChanged(event: DeliveredEvent): Promise<void> {
    const { teacherId, feature, enabled } = parse(featureChanged, event);
    await this.notifications.schedule({
      type: 'feature.changed',
      recipientId: teacherId,
      payload: { feature, enabled: enabled ? 'on' : 'off' },
      dedupeKey: `feature.changed:${event.id}`,
    });
  }

  private async roleGranted(event: DeliveredEvent): Promise<void> {
    const { accountId, role } = parse(roleGranted, event);
    if (role !== 'ADMIN') return; // teacher grants are part of onboarding
    await this.notifications.schedule({
      type: 'role.granted',
      recipientId: accountId,
      payload: { role: 'admin' },
      dedupeKey: `role.granted:${event.id}`,
    });
  }

  private async accountUnblocked(event: DeliveredEvent): Promise<void> {
    const { accountId } = parse(accountUnblocked, event);
    await this.notifications.schedule({
      type: 'account.unblocked',
      recipientId: accountId,
      dedupeKey: `account.unblocked:${event.id}`,
    });
  }
}
