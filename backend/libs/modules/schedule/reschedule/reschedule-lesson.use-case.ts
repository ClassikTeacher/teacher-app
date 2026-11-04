import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock, DAY_MS, MINUTE_MS } from '@shared/time/clock.js';
import { type Actor, assertActive, assertRole, primaryRole } from '@modules/access/actor.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { DEFAULT_NOTICE_TEXT } from '@modules/people/teacher-profile.defaults.js';
import { LessonRepository } from '../lessons/lesson.repository.js';
import { MAX_LESSON_HORIZON_DAYS, normalizeDuration } from '../lessons/lesson.rules.js';
import { WindowsPolicy } from '../lessons/windows.policy.js';
import { OccupancyService } from '../occupancy/occupancy.service.js';
import { BookingRequestRepository } from '../requests/booking-request.repository.js';
import type { Interval, LessonRow } from '../schema.js';

export const MAX_RESCHEDULE_COMMENT_LENGTH = 500;

export interface RescheduleInput {
  lessonId: string;
  startsAt: Date;
  /** Defaults to the lesson's current duration. */
  durationMin?: number;
  /** Optional for the teacher (Р-8): the profile's default notice text is sent when empty (CNL-09). */
  comment?: string | null;
  /** Set when the move fulfils a student's request (5.7.4): that student gets the decision, not the move notice. */
  acceptedRequest?: { id: string; studentId: string } | null;
}

export interface ObjectionInput {
  lessonId: string;
  reason: string;
  /** The child, when a parent objects (Р-25). */
  studentId?: string;
}

const clean = (value: string | null | undefined, max: number): string => {
  const text = (value ?? '').trim();
  if (text.length > max) throw AppError.validation('Comment is too long', { max });
  return text;
};

/**
 * 5.7.4 «Перенос»: the teacher moves their own scheduled lesson at once — everyone's occupancy is re-reserved
 * through CAL-01 in one transaction (a conflict names the busy party), the version grows (NTF-05 reminders are
 * re-planned by the notifications handler), the history keeps old and new time, initiator and comment, and
 * `lesson.rescheduled` tells the participants with «ОК / Не могу в это время» (CNL-09). Pending requests about
 * the lesson are closed as superseded. An objection («Не могу») needs a reason and reaches the teacher.
 */
@Injectable()
export class RescheduleLessonUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly lessons: LessonRepository,
    private readonly occupancy: OccupancyService,
    private readonly profiles: TeacherProfileRepository,
    private readonly windows: WindowsPolicy,
    private readonly requests: BookingRequestRepository,
    private readonly family: FamilyLinkRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  async execute(actor: Actor, input: RescheduleInput): Promise<LessonRow> {
    assertRole(actor, 'TEACHER');
    const comment = clean(input.comment, MAX_RESCHEDULE_COMMENT_LENGTH);
    const now = this.clock.now();
    return this.txm.run(async () => {
      const lesson = await this.lessons.findById(input.lessonId, { forUpdate: true });
      if (!lesson || lesson.teacherId !== actor.accountId) throw AppError.notFound('lesson', input.lessonId);
      if (lesson.status !== 'scheduled')
        throw new AppError('CONFLICT', 'Lesson is not scheduled any more', { status: lesson.status });
      const profile = await this.profiles.find(lesson.teacherId);
      if (!profile) throw AppError.notFound('teacher profile', lesson.teacherId);
      const durationMin = normalizeDuration(
        input.durationMin ?? Math.round((lesson.endsAt.getTime() - lesson.startsAt.getTime()) / MINUTE_MS),
      );
      const to = this.interval(input.startsAt, durationMin, now);
      if (to.start.getTime() === lesson.startsAt.getTime() && to.end.getTime() === lesson.endsAt.getTime())
        throw AppError.validation('The lesson already takes place at this time', { reason: 'same_time' });
      const participants = (await this.lessons.listParticipants(lesson.id)).map((p) => p.studentId);
      await this.occupancy.releaseLesson(lesson.id);
      await this.occupancy.reserve({
        source: { kind: 'lesson', lessonId: lesson.id },
        during: to,
        teacher: {
          accountId: lesson.teacherId,
          bufferBeforeMin: profile.bufferBeforeMin,
          bufferAfterMin: profile.bufferAfterMin,
        },
        studentIds: participants,
      }); // LESSON_CONFLICT rolls everything back, the old time stays reserved
      const outsideWindows = await this.windows.isOutsideWindows(lesson.teacherId, to);
      const updated = await this.lessons.update(
        lesson.id,
        { startsAt: to.start, endsAt: to.end, outsideWindows },
        { bumpVersion: true },
      );
      const message = comment || profile.defaultNoticeText.trim() || DEFAULT_NOTICE_TEXT;
      const from = { startsAt: lesson.startsAt.toISOString(), endsAt: lesson.endsAt.toISOString() };
      const dest = { startsAt: to.start.toISOString(), endsAt: to.end.toISOString() };
      await this.lessons.addEvent({
        lessonId: lesson.id,
        type: 'rescheduled',
        actorId: actor.accountId,
        payload: { from, to: dest, comment: message, requestId: input.acceptedRequest?.id ?? null },
        at: now,
      });
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: primaryRole(actor),
        action: 'lesson.rescheduled',
        entityType: 'lesson',
        entityId: lesson.id,
        before: from,
        after: { ...dest, outsideWindows, hasComment: !!comment },
        source: actor.source,
        ip: actor.ip,
      });
      await this.supersedeRequests(lesson.id, input.acceptedRequest?.id ?? null, now);
      await this.outbox.publish({
        type: 'lesson.rescheduled',
        aggregateType: 'lesson',
        aggregateId: lesson.id,
        payload: {
          lessonId: lesson.id,
          teacherId: lesson.teacherId,
          groupId: lesson.groupId,
          subjectId: lesson.subjectId,
          studentIds: participants,
          from,
          to: dest,
          version: updated.version,
          comment: message,
          byAccountId: actor.accountId,
          byRole: 'TEACHER',
          requestId: input.acceptedRequest?.id ?? null,
          requestedBy: input.acceptedRequest?.studentId ?? null,
        },
      });
      return updated;
    });
  }

  /** «Не могу в это время» (5.7.4): a reason is required; the teacher learns about it; the lesson stays. */
  async object(actor: Actor, input: ObjectionInput): Promise<void> {
    assertActive(actor);
    const reason = clean(input.reason, MAX_RESCHEDULE_COMMENT_LENGTH);
    if (!reason) throw AppError.validation('A reason is required', { reason: 'reason_required' });
    const now = this.clock.now();
    await this.txm.run(async () => {
      const lesson = await this.lessons.findById(input.lessonId);
      if (!lesson) throw AppError.notFound('lesson', input.lessonId);
      const { studentId, role } = await this.participantOf(actor, lesson, input.studentId);
      if (lesson.status !== 'scheduled' || lesson.startsAt.getTime() <= now.getTime())
        throw new AppError('CONFLICT', 'The lesson cannot be objected to any more', {
          status: lesson.status,
        });
      // one objection per student and version of the time: the notice's buttons may be pressed twice
      const already = (await this.lessons.listEvents(lesson.id)).some(
        (e) =>
          e.type === 'reschedule_objection' &&
          e.payload['studentId'] === studentId &&
          e.payload['version'] === lesson.version,
      );
      if (already) throw new AppError('CONFLICT', 'Already objected', { reason: 'already_objected' });
      await this.lessons.addEvent({
        lessonId: lesson.id,
        type: 'reschedule_objection',
        actorId: actor.accountId,
        payload: { studentId, role, reason, version: lesson.version },
        at: now,
      });
      await this.outbox.publish({
        type: 'lesson.reschedule_objection',
        aggregateType: 'lesson',
        aggregateId: lesson.id,
        payload: {
          lessonId: lesson.id,
          teacherId: lesson.teacherId,
          studentId,
          startsAt: lesson.startsAt.toISOString(),
          reason,
          byAccountId: actor.accountId,
          byRole: role,
          version: lesson.version,
        },
      });
    });
  }

  /** «ОК» on the move notice: recorded in the history only (Р-30: no attendance confirmation in MVP). */
  async acknowledge(actor: Actor, lessonId: string, childId?: string): Promise<void> {
    assertActive(actor);
    const lesson = await this.lessons.findById(lessonId);
    if (!lesson) throw AppError.notFound('lesson', lessonId);
    const { studentId, role } = await this.participantOf(actor, lesson, childId);
    await this.lessons.addEvent({
      lessonId: lesson.id,
      type: 'reschedule_ack',
      actorId: actor.accountId,
      payload: { studentId, role, version: lesson.version },
      at: this.clock.now(),
    });
  }

  /** The student themself, or a parent of a participating child (8.0). */
  private async participantOf(
    actor: Actor,
    lesson: LessonRow,
    childId: string | undefined,
  ): Promise<{ studentId: string; role: 'STUDENT' | 'PARENT' }> {
    const participants = (await this.lessons.listParticipants(lesson.id)).map((p) => p.studentId);
    if (actor.roles.includes('PARENT') && childId && childId !== actor.accountId) {
      if (!(await this.family.findActive(actor.accountId, childId)) || !participants.includes(childId))
        throw AppError.notFound('lesson', lesson.id);
      return { studentId: childId, role: 'PARENT' };
    }
    if (actor.roles.includes('STUDENT') && participants.includes(actor.accountId))
      return { studentId: actor.accountId, role: 'STUDENT' };
    throw AppError.notFound('lesson', lesson.id);
  }

  /** Requests about the lesson that are still open lose their subject; the accepted one is decided by the caller. */
  private async supersedeRequests(lessonId: string, acceptedId: string | null, now: Date): Promise<void> {
    for (const request of await this.requests.lockPendingByLesson(lessonId)) {
      if (request.id === acceptedId) continue;
      await this.requests.decide(request.id, {
        status: 'cancelled',
        decidedBy: null,
        decisionReason: 'lesson_changed',
        decidedAt: now,
      });
      await this.outbox.publish({
        type: 'booking.decided',
        aggregateType: 'booking_request',
        aggregateId: request.id,
        payload: {
          requestId: request.id,
          teacherId: request.teacherId,
          studentId: request.studentId,
          kind: request.kind,
          lessonId: request.lessonId,
          status: 'cancelled',
          reason: 'lesson_changed',
          message: null,
          startsAt: request.startsAt?.toISOString() ?? null,
          openSlots: [],
        },
      });
    }
  }

  private interval(startsAt: Date, durationMin: number, now: Date): Interval {
    if (Number.isNaN(startsAt.getTime())) throw AppError.validation('startsAt is invalid');
    if (startsAt.getTime() - now.getTime() > MAX_LESSON_HORIZON_DAYS * DAY_MS)
      throw AppError.validation('Lesson is too far ahead', { maxDays: MAX_LESSON_HORIZON_DAYS });
    const end = new Date(startsAt.getTime() + durationMin * MINUTE_MS);
    if (end.getTime() <= now.getTime())
      throw AppError.validation('Lesson is entirely in the past', { reason: 'past' });
    return { start: startsAt, end };
  }
}
