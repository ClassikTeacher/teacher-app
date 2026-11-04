import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { addHours } from '@shared/time/clock.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { type DeliveredEvent, DomainEventBus } from '@modules/outbox/event-bus.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { LEAVE_REQUEST_REMINDER_HOURS, LEAVE_REQUEST_TTL_HOURS } from '@modules/people/links/link.rules.js';
import { NotificationService } from '../notification.service.js';
import { NotificationRenderer } from '../render.js';
import { BUTTONS_PAYLOAD_KEY } from '../types.js';

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const uuid = z.string().uuid();
const linkEnded = z.object({
  linkId: uuid,
  teacherId: uuid,
  studentId: uuid,
  reason: z.enum(['removed_by_teacher', 'left_by_student', 'ended_by_parent', 'system']),
  byAccountId: uuid.nullable(),
  cancelledRequestId: uuid.nullable().optional(),
  message: z.string(),
});
const leaveRequested = z.object({
  requestId: uuid,
  teacherId: uuid,
  studentId: uuid,
  parentIds: z.array(uuid),
  reason: z.string(),
  expiresAt: z.string().datetime(),
});
const leaveDecided = z.object({
  requestId: uuid,
  teacherId: uuid,
  studentId: uuid,
  decidedBy: uuid,
  approved: z.boolean(),
  comment: z.string().nullable(),
});
const leaveExpired = z.object({ requestId: uuid, studentId: uuid });

function parse<T>(schema: z.ZodType<T>, event: DeliveredEvent): T {
  const result = schema.safeParse(event.payload);
  if (!result.success)
    throw new UnrecoverableError(`malformed ${event.type} payload: ${result.error.message}`);
  return result.data;
}

/**
 * 5.8 messages: `link.ended` to the student, the teacher and the parents (critical, 5.13.1); the parents'
 * consent request with buttons (LINK-02) and its 48-hour reminder (LINK-04); the decision to the student and
 * the other parents (LINK-03); expiry to the student. The teacher hears nothing about an open request (LINK-05).
 */
@Injectable()
export class LinkEventsHandler implements OnModuleInit {
  private readonly labels = new NotificationRenderer();

  constructor(
    private readonly bus: DomainEventBus,
    private readonly accounts: AccountRepository,
    private readonly family: FamilyLinkRepository,
    private readonly notifications: NotificationService,
  ) {}

  onModuleInit(): void {
    this.bus.on('link.ended', (e) => this.ended(e));
    this.bus.on('link.leave_requested', (e) => this.requested(e));
    this.bus.on('link.leave_decided', (e) => this.decided(e));
    this.bus.on('link.leave_expired', (e) => this.expired(e));
  }

  private async nameOf(accountId: string): Promise<string> {
    const a = await this.accounts.findById(accountId);
    return a ? esc(`${a.firstName} ${a.lastName}`.trim() || '—') : '—';
  }

  private async ended(event: DeliveredEvent): Promise<void> {
    const p = parse(linkEnded, event);
    // an open consent request died with the link: no 48-hour reminder for it (LINK-04)
    if (p.cancelledRequestId)
      await this.notifications.cancelByPrefix(`link.leave_reminder:${p.cancelledRequestId}:`);
    const base = {
      teacher: await this.nameOf(p.teacherId),
      student: await this.nameOf(p.studentId),
      reason: this.labels.t(`end-reason-${p.reason.replace(/_/g, '-')}`),
      message: esc(p.message),
    };
    const send = (recipientId: string, view: string, bot?: 'student' | 'parent') =>
      this.notifications.schedule({
        type: 'link.ended',
        recipientId,
        ...(bot ? { bot } : {}),
        payload: { ...base, view },
        dedupeKey: `link.ended:${event.id}:${recipientId}`,
      });
    // nobody is told about their own action; after a consent request the student and the parents already get
    // link.leave_decided, so only the teacher learns the outcome here (LINK-05)
    const viaConsent = p.reason === 'left_by_student';
    if (p.byAccountId !== p.studentId && !viaConsent) await send(p.studentId, 'student', 'student');
    if (p.byAccountId !== p.teacherId) await send(p.teacherId, 'teacher');
    if (!viaConsent) {
      for (const parent of await this.family.listActiveByStudent(p.studentId)) {
        if (parent.parentId !== p.byAccountId) await send(parent.parentId, 'parent', 'parent');
      }
    }
  }

  private async requested(event: DeliveredEvent): Promise<void> {
    const p = parse(leaveRequested, event);
    const payload = {
      student: await this.nameOf(p.studentId),
      teacher: await this.nameOf(p.teacherId),
      reason: esc(p.reason),
      [BUTTONS_PAYLOAD_KEY]: [
        { text: this.labels.t('btn-leave-approve'), data: `m:lr:ok:${p.requestId}` },
        { text: this.labels.t('btn-leave-decline'), data: `m:lr:no:${p.requestId}` },
      ],
    };
    for (const parentId of p.parentIds) {
      await this.notifications.schedule({
        type: 'link.leave_request',
        recipientId: parentId,
        bot: 'parent',
        payload,
        dedupeKey: `link.leave_request:${p.requestId}:${parentId}`,
      });
      await this.notifications.schedule({
        type: 'link.leave_reminder',
        recipientId: parentId,
        bot: 'parent',
        payload,
        dedupeKey: `link.leave_reminder:${p.requestId}:${parentId}`,
        // counted from the request itself (deadline minus the 7 days), so outbox delays do not shift it
        dueAt: addHours(new Date(p.expiresAt), LEAVE_REQUEST_REMINDER_HOURS - LEAVE_REQUEST_TTL_HOURS),
      });
    }
  }

  private async decided(event: DeliveredEvent): Promise<void> {
    const p = parse(leaveDecided, event);
    await this.notifications.cancelByPrefix(`link.leave_reminder:${p.requestId}:`);
    const payload = {
      teacher: await this.nameOf(p.teacherId),
      student: await this.nameOf(p.studentId),
      parent: await this.nameOf(p.decidedBy),
      decision: p.approved ? 'approved' : 'declined',
      comment: p.comment ? esc(p.comment) : '',
    };
    await this.notifications.schedule({
      type: 'link.leave_decided',
      recipientId: p.studentId,
      bot: 'student',
      payload: { ...payload, view: 'student' },
      dedupeKey: `link.leave_decided:${p.requestId}:${p.studentId}`,
    });
    for (const parent of await this.family.listActiveByStudent(p.studentId)) {
      if (parent.parentId === p.decidedBy) continue;
      await this.notifications.schedule({
        type: 'link.leave_decided',
        recipientId: parent.parentId,
        bot: 'parent',
        payload: { ...payload, view: 'parent' },
        dedupeKey: `link.leave_decided:${p.requestId}:${parent.parentId}`,
      });
    }
  }

  private async expired(event: DeliveredEvent): Promise<void> {
    const p = parse(leaveExpired, event);
    await this.notifications.cancelByPrefix(`link.leave_reminder:${p.requestId}:`);
    await this.notifications.schedule({
      type: 'link.leave_expired',
      recipientId: p.studentId,
      bot: 'student',
      payload: {},
      dedupeKey: `link.leave_expired:${p.requestId}`,
    });
  }
}
