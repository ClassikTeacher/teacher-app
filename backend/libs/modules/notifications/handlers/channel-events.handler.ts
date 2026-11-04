import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { type DeliveredEvent, DomainEventBus } from '@modules/outbox/event-bus.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { NotificationService } from '../notification.service.js';

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unreachable = z.object({ accountId: z.string().uuid(), bot: z.string(), error: z.string() });

function parse<T>(schema: z.ZodType<T>, event: DeliveredEvent): T {
  const result = schema.safeParse(event.payload);
  if (!result.success)
    throw new UnrecoverableError(`malformed ${event.type} payload: ${result.error.message}`);
  return result.data;
}

/** NTF-09: a student blocked StudentBot → every active teacher of theirs is warned once per incident. */
@Injectable()
export class ChannelEventsHandler implements OnModuleInit {
  constructor(
    private readonly bus: DomainEventBus,
    private readonly accounts: AccountRepository,
    private readonly links: TeacherStudentRepository,
    private readonly notifications: NotificationService,
  ) {}

  onModuleInit(): void {
    this.bus.on('channel.unreachable', (e) => this.unreachable(e));
  }

  private async unreachable(event: DeliveredEvent): Promise<void> {
    const p = parse(unreachable, event);
    if (p.bot !== 'student') return; // a parent or a teacher blocking a bot is their own business
    const student = await this.accounts.findById(p.accountId);
    if (!student) return;
    for (const link of await this.links.listByStudent(student.id, ['active'])) {
      await this.notifications.schedule({
        type: 'channel.unreachable',
        recipientId: link.teacherId,
        payload: { student: esc(`${student.firstName} ${student.lastName}`.trim()) },
        dedupeKey: `channel.unreachable:${event.id}:${link.teacherId}`,
      });
    }
  }
}
