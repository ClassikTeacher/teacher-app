import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { Clock } from '@shared/time/clock.js';
import { isGrantOpen } from '@modules/content/content-access.query.js';
import { GrantRepository } from '@modules/content/grant.repository.js';
import { MaterialRepository } from '@modules/content/material.repository.js';
import type { AccessGrantRow } from '@modules/content/schema.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { type DeliveredEvent, DomainEventBus } from '@modules/outbox/event-bus.js';
import { NotificationService } from '../notification.service.js';
import { NotificationRenderer } from '../render.js';
import { BUTTONS_PAYLOAD_KEY } from '../types.js';

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const uuid = z.string().uuid();
const granted = z.object({ grantId: uuid, subjectType: z.string(), studentIds: z.array(uuid) });
const revoked = z.object({ grantId: uuid });
const memberAdded = z.object({ groupId: uuid, studentId: uuid });

function parse<T>(schema: z.ZodType<T>, event: DeliveredEvent): T {
  const result = schema.safeParse(event.payload);
  if (!result.success)
    throw new UnrecoverableError(`malformed ${event.type} payload: ${result.error.message}`);
  return result.data;
}

/**
 * 5.9.3: a new grant → `material.granted` to each student (copy to parents by the teacher's setting), due at
 * the opening moment when the grant is delayed; the grant is re-read, so one revoked meanwhile stays silent
 * (MAT-02), and a pending delayed message is dropped on `content.revoked`. A student joining a group learns
 * about the group's live grants. Assignments notify through their own events (M5-03).
 */
@Injectable()
export class ContentEventsHandler implements OnModuleInit {
  private readonly labels = new NotificationRenderer();

  constructor(
    private readonly bus: DomainEventBus,
    private readonly accounts: AccountRepository,
    private readonly materials: MaterialRepository,
    private readonly grants: GrantRepository,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.bus.on('content.granted', (e) => this.granted(e));
    this.bus.on('content.revoked', (e) => this.revoked(e));
    this.bus.on('group.member_added', (e) => this.memberAdded(e));
  }

  private async granted(event: DeliveredEvent): Promise<void> {
    const p = parse(granted, event);
    if (p.subjectType === 'assignment' || p.studentIds.length === 0) return;
    const grant = await this.grants.findById(p.grantId);
    if (!grant || grant.revokedAt) return;
    await this.notify(grant, p.studentIds);
  }

  private async revoked(event: DeliveredEvent): Promise<void> {
    const p = parse(revoked, event);
    await this.notifications.cancelByPrefix(`material.granted:${p.grantId}:`);
  }

  private async memberAdded(event: DeliveredEvent): Promise<void> {
    const p = parse(memberAdded, event);
    for (const g of await this.grants.listByGroup(p.groupId)) {
      if (g.subjectType !== 'assignment') await this.notify(g, [p.studentId]);
    }
  }

  private async notify(grant: AccessGrantRow, studentIds: readonly string[]): Promise<void> {
    const now = this.clock.now();
    // a delayed grant is announced when it opens; one already past its end says nothing
    const dueAt =
      grant.availableFrom && grant.availableFrom.getTime() > now.getTime() ? grant.availableFrom : now;
    if (!isGrantOpen(grant, dueAt)) return;
    const [teacher, subject] = await Promise.all([
      this.accounts.findById(grant.teacherId),
      grant.subjectType === 'material'
        ? this.materials.findById(grant.subjectId)
        : this.materials.findCollection(grant.subjectId),
    ]);
    if (!teacher || !subject || subject.archivedAt) return;
    const open =
      grant.subjectType === 'material'
        ? `s:materials:m:${grant.subjectId}`
        : `s:materials:c:${grant.subjectId}`;
    for (const student of await this.accounts.findByIds(studentIds)) {
      await this.notifications.schedule({
        type: 'material.granted',
        recipientId: student.id,
        bot: 'student',
        payload: {
          kind: grant.subjectType,
          title: esc(subject.title),
          teacher: esc(`${teacher.firstName} ${teacher.lastName}`.trim()),
          [BUTTONS_PAYLOAD_KEY]: [{ text: this.labels.t('btn-open-material'), data: open }],
        },
        dedupeKey: `material.granted:${grant.id}:${student.id}`,
        dueAt,
        teacherId: grant.teacherId,
      });
    }
  }
}
