import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { Clock } from '@shared/time/clock.js';
import { type DeliveredEvent, DomainEventBus } from '@modules/outbox/event-bus.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { LessonRepository } from '../lessons/lesson.repository.js';
import { BookingRequestRepository } from '../requests/booking-request.repository.js';
import type { LessonRow } from '../schema.js';
import { SeriesRepository } from '../series/series.repository.js';
import { SeriesUseCase } from '../series/series.use-case.js';
import { type CancelContext, CancelLessonUseCase } from './cancel-lesson.use-case.js';
import { CancellationRepository } from './cancellation.repository.js';

const uuid = z.string().uuid();
const linkEnded = z.object({
  teacherId: uuid,
  studentId: uuid,
  reason: z.string(),
  byAccountId: uuid.nullable(),
  message: z.string().nullable(),
});
const blocked = z.object({
  accountId: uuid,
  roles: z.array(z.string()),
  lessonsPolicy: z.enum(['cancel', 'keep']),
  message: z.string().nullable(),
  byAccountId: uuid.nullable(),
});
/** 5.7.6 «все будущие занятия»: no upper bound. */
const FAR_FUTURE = new Date('9999-12-31T00:00:00Z');

function parse<T>(schema: z.ZodType<T>, event: DeliveredEvent): T {
  const result = schema.safeParse(event.payload);
  if (!result.success)
    throw new UnrecoverableError(`malformed ${event.type} payload: ${result.error.message}`);
  return result.data;
}

/**
 * 5.7.6 «Автоматические отмены»: a link ends → the pair's future individual lessons are cancelled with the
 * initiator's message (group lessons: the student leaves them, `GroupMembershipHandler`); an account is
 * blocked with the «cancel» policy → every future lesson of the person, with the admin's message. One system
 * cancellation record per event (CNL-08), one summary per recipient (NTF-07), pending requests of the pair are
 * closed. Idempotent: a re-delivered event finds nothing scheduled.
 */
@Injectable()
export class AutoCancelHandler implements OnModuleInit {
  private readonly logger = new Logger(AutoCancelHandler.name);

  constructor(
    private readonly bus: DomainEventBus,
    private readonly txm: TransactionManager,
    private readonly lessons: LessonRepository,
    private readonly cancel: CancelLessonUseCase,
    private readonly cancellations: CancellationRepository,
    private readonly requests: BookingRequestRepository,
    private readonly links: TeacherStudentRepository,
    private readonly accounts: AccountRepository,
    private readonly seriesRepo: SeriesRepository,
    private readonly seriesUseCase: SeriesUseCase,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.bus.on('link.ended', (e) => this.linkEnded(e));
    this.bus.on('account.blocked', (e) => this.accountBlocked(e));
  }

  private async linkEnded(event: DeliveredEvent): Promise<void> {
    const p = parse(linkEnded, event);
    const now = this.clock.now();
    await this.txm.run(async () => {
      // a stale or re-delivered event must not touch a link that was re-created meanwhile
      const link = await this.links.findByPair(p.teacherId, p.studentId);
      if (link?.status !== 'ended') return;
      const range = { start: now, end: FAR_FUTURE };
      const candidates = (await this.lessons.listByStudent(p.studentId, range, ['scheduled'])).filter(
        (l) => l.teacherId === p.teacherId && l.groupId === null && l.startsAt.getTime() > now.getTime(),
      );
      await this.cancelAll(
        candidates,
        'link.ended',
        p.message || 'link_ended',
        p.byAccountId,
        p.byAccountId,
        now,
      );
      await this.closeRequests(p.teacherId, p.studentId, now);
    });
  }

  private async accountBlocked(event: DeliveredEvent): Promise<void> {
    const p = parse(blocked, event);
    if (p.lessonsPolicy !== 'cancel') return; // ACC-02 «оставить занятия»
    const now = this.clock.now();
    await this.txm.run(async () => {
      if ((await this.accounts.findById(p.accountId))?.status !== 'blocked') return; // unblocked meanwhile
      const range = { start: now, end: FAR_FUTURE };
      const taught = p.roles.includes('TEACHER')
        ? await this.lessons.listByTeacher(p.accountId, range, ['scheduled'])
        : [];
      // a blocked student: their individual lessons go; group lessons only lose them as a participant
      const taken = p.roles.includes('STUDENT')
        ? (await this.lessons.listByStudent(p.accountId, range, ['scheduled'])).filter(
            (l) => l.groupId === null,
          )
        : [];
      const all = [...taught, ...taken].filter((l) => l.startsAt.getTime() > now.getTime());
      await this.cancelAll(
        all,
        'account.blocked',
        p.message || 'account_blocked',
        p.byAccountId,
        p.accountId,
        now,
      );
      if (p.roles.includes('STUDENT')) await this.leaveGroupLessons(p.accountId, range, now);
      // H-1: the series of a blocked teacher or student would keep materialising new lessons — end them
      const series = [
        ...(p.roles.includes('TEACHER') ? await this.seriesRepo.listActiveByTeacher(p.accountId) : []),
        ...(p.roles.includes('STUDENT') ? await this.seriesRepo.listActiveByStudent(p.accountId) : []),
      ];
      for (const row of series) await this.seriesUseCase.endBySystem(row.id, p.byAccountId);
      for (const r of await this.requests.listPendingByStudent(p.accountId))
        await this.decline(
          r.id,
          r.teacherId,
          r.studentId,
          r.kind,
          r.lessonId,
          r.startsAt,
          'account_blocked',
          now,
        );
      for (const r of await this.requests.listPendingByTeacher(p.accountId))
        await this.decline(
          r.id,
          r.teacherId,
          r.studentId,
          r.kind,
          r.lessonId,
          r.startsAt,
          'account_blocked',
          now,
        );
    });
  }

  /** Locks the lessons in id order and cancels them as one system batch; nothing when none is left. */
  private async cancelAll(
    candidates: LessonRow[],
    source: 'link.ended' | 'account.blocked',
    message: string,
    byAccountId: string | null,
    subjectAccountId: string | null,
    now: Date,
  ): Promise<void> {
    const locked = (await this.lessons.lockByIds(candidates.map((l) => l.id))).filter(
      (l) => l.status === 'scheduled' && l.startsAt.getTime() > now.getTime(),
    );
    if (locked.length === 0) return;
    const cancellation = await this.cancellations.insert({
      initiatorId: byAccountId,
      initiatorRole: 'SYSTEM',
      kind: 'system',
      reason: message.slice(0, 500),
      source,
      createdAt: now,
    });
    const ctx: CancelContext = { cancellation, role: 'SYSTEM', actorId: byAccountId, source: 'system' };
    const items = [];
    for (const lesson of locked) {
      const studentIds = (await this.lessons.listParticipants(lesson.id)).map((x) => x.studentId);
      await this.cancel.cancelLocked(lesson, ctx, false, now);
      items.push({
        lessonId: lesson.id,
        teacherId: lesson.teacherId,
        startsAt: lesson.startsAt.toISOString(),
        studentIds,
        action: 'cancelled',
        isLate: false,
      });
    }
    await this.outbox.publish({
      type: 'cancellation.bulk',
      aggregateType: 'cancellation',
      aggregateId: cancellation.id,
      payload: {
        cancellationId: cancellation.id,
        byAccountId,
        byRole: 'SYSTEM',
        source,
        subjectAccountId,
        onBehalfOfStudentId: null,
        message: cancellation.reason,
        lessons: items,
      },
    });
    this.logger.debug({ source, count: items.length }, 'lessons auto-cancelled');
  }

  /** A blocked student leaves future group lessons (their time freed); the group stays for the others. */
  private async leaveGroupLessons(
    studentId: string,
    range: { start: Date; end: Date },
    now: Date,
  ): Promise<void> {
    const group = (await this.lessons.listByStudent(studentId, range, ['scheduled'])).filter(
      (l) => l.groupId !== null && l.startsAt.getTime() > now.getTime(),
    );
    const left = new Map<string, string[]>();
    for (const lesson of await this.lessons.lockByIds(group.map((l) => l.id))) {
      if (lesson.status !== 'scheduled' || lesson.startsAt.getTime() <= now.getTime()) continue;
      const removed = await this.lessons.removeParticipant(lesson.id, studentId, now);
      if (!removed) continue;
      await this.cancel.releaseFor(lesson.id, studentId);
      await this.lessons.update(lesson.id, {}, { bumpVersion: true });
      await this.lessons.addEvent({
        lessonId: lesson.id,
        type: 'participant_removed',
        actorId: null,
        payload: { studentIds: [studentId], reason: 'account.blocked' },
        at: now,
      });
      left.set(lesson.groupId!, [...(left.get(lesson.groupId!) ?? []), lesson.startsAt.toISOString()]);
      await this.outbox.publish({
        type: 'lesson.participants_changed',
        aggregateType: 'lesson',
        aggregateId: lesson.id,
        payload: {
          lessonId: lesson.id,
          teacherId: lesson.teacherId,
          groupId: lesson.groupId,
          startsAt: lesson.startsAt.toISOString(),
          endsAt: lesson.endsAt.toISOString(),
          added: [],
          removed: [studentId],
        },
      });
    }
    for (const [groupId, starts] of left) {
      await this.outbox.publish({
        type: 'group.lessons_left',
        aggregateType: 'study_group',
        aggregateId: groupId,
        payload: {
          groupId,
          groupName: '',
          teacherId: null,
          studentId,
          reason: 'account.blocked',
          startsAt: starts,
        },
      });
    }
  }

  /** Pending requests between the pair lose their subject (5.8.4). */
  private async closeRequests(teacherId: string, studentId: string, now: Date): Promise<void> {
    for (const r of await this.requests.listPendingByStudent(studentId)) {
      if (r.teacherId !== teacherId) continue;
      await this.decline(r.id, r.teacherId, r.studentId, r.kind, r.lessonId, r.startsAt, 'link_ended', now);
    }
  }

  private async decline(
    requestId: string,
    teacherId: string,
    studentId: string,
    kind: string,
    lessonId: string | null,
    startsAt: Date | null,
    reason: 'link_ended' | 'account_blocked',
    now: Date,
  ): Promise<void> {
    const decided = await this.requests.decide(requestId, {
      status: 'cancelled',
      decidedBy: null,
      decisionReason: reason,
      decidedAt: now,
    });
    if (!decided) return;
    await this.outbox.publish({
      type: 'booking.decided',
      aggregateType: 'booking_request',
      aggregateId: requestId,
      payload: {
        requestId,
        teacherId,
        studentId,
        kind,
        lessonId,
        status: 'cancelled',
        reason,
        message: null,
        startsAt: startsAt?.toISOString() ?? null,
        openSlots: [],
      },
    });
  }
}
