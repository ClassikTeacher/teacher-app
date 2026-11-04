import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { type DeliveredEvent, DomainEventBus } from '@modules/outbox/event-bus.js';
import { NotificationService } from '../notification.service.js';
import { NotificationRenderer } from '../render.js';

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const familyActivated = z.object({
  parentId: z.string().uuid(),
  studentId: z.string().uuid(),
  teacherId: z.string().uuid(),
});
const familyRevoked = z.object({
  parentId: z.string().uuid(),
  studentId: z.string().uuid(),
  teacherId: z.string().uuid().nullable(),
  by: z.enum(['parent', 'teacher', 'admin']),
});

function parse<T>(schema: z.ZodType<T>, event: DeliveredEvent): T {
  const result = schema.safeParse(event.payload);
  if (!result.success)
    throw new UnrecoverableError(`malformed ${event.type} payload: ${result.error.message}`);
  return result.data;
}

/** UC-11 step 4: the student learns a parent was attached, the teacher that the parent connected; revocations likewise. */
@Injectable()
export class FamilyEventsHandler implements OnModuleInit {
  private readonly labels = new NotificationRenderer();

  constructor(
    private readonly bus: DomainEventBus,
    private readonly accounts: AccountRepository,
    private readonly notifications: NotificationService,
  ) {}

  onModuleInit(): void {
    this.bus.on('family.activated', (e) => this.activated(e));
    this.bus.on('family.revoked', (e) => this.revoked(e));
  }

  private async nameOf(accountId: string): Promise<string> {
    const a = await this.accounts.findById(accountId);
    return a ? esc(`${a.firstName} ${a.lastName}`.trim() || '—') : '—';
  }

  private async activated(event: DeliveredEvent): Promise<void> {
    const { parentId, studentId, teacherId } = parse(familyActivated, event);
    const payload = { parent: await this.nameOf(parentId), child: await this.nameOf(studentId) };
    await this.notifications.schedule({
      type: 'family.parent_linked',
      recipientId: studentId,
      bot: 'student',
      payload,
      dedupeKey: `family.parent_linked:${event.id}`,
    });
    await this.notifications.schedule({
      type: 'family.parent_connected',
      recipientId: teacherId,
      payload,
      dedupeKey: `family.parent_connected:${event.id}`,
    });
  }

  /** Each recipient gets a text in their own perspective; whoever revoked is not told about their own action. */
  private async revoked(event: DeliveredEvent): Promise<void> {
    const { parentId, studentId, teacherId, by } = parse(familyRevoked, event);
    const base = {
      parent: await this.nameOf(parentId),
      child: await this.nameOf(studentId),
      byText: this.labels.t(`family-by-${by}`),
    };
    const send = (recipientId: string, view: 'student' | 'teacher' | 'parent', bot?: 'student' | 'parent') =>
      this.notifications.schedule({
        type: 'family.parent_unlinked',
        recipientId,
        ...(bot ? { bot } : {}),
        payload: { ...base, view },
        dedupeKey: `family.parent_unlinked:${event.id}:${view}`,
      });
    await send(studentId, 'student', 'student');
    if (teacherId && by !== 'teacher') await send(teacherId, 'teacher');
    if (by !== 'parent') await send(parentId, 'parent', 'parent');
  }
}
