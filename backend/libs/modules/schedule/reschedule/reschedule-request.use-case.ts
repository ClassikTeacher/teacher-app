import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock, DAY_MS, HOUR_MS, MINUTE_MS } from '@shared/time/clock.js';
import { type Actor, assertActive, assertRole } from '@modules/access/actor.js';
import { FeatureService } from '@modules/access/features/feature.service.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import {
  DEFAULT_BOOKING_RULES,
  isCalendarOpenFor,
  OpenSlotsQuery,
} from '../availability/open-slots.query.js';
import { WeeklyLimitPolicy } from '../booking/weekly-limit.policy.js';
import { CreateLessonUseCase } from '../lessons/create-lesson.use-case.js';
import { LessonRepository } from '../lessons/lesson.repository.js';
import { BookingRequestRepository } from '../requests/booking-request.repository.js';
import type { BookingRequestRow, LessonRow } from '../schema.js';
import { MAX_RESCHEDULE_COMMENT_LENGTH, RescheduleLessonUseCase } from './reschedule-lesson.use-case.js';

export interface RescheduleRequestInput {
  lessonId: string;
  /** Start of the wanted open slot; the duration stays the lesson's. */
  startsAt: Date;
  /** Mandatory for a student or a parent (5.7.4). */
  reason: string;
  /** The child, when a parent asks (Р-25). */
  studentId?: string;
}

export interface AskInput {
  lessonId: string;
  reason: string;
  studentId?: string;
}

export interface DecideInput {
  requestId: string;
  accept: boolean;
  /** The teacher's message on a decline (template or own text); optional on accept. */
  message?: string | null;
}

export interface RequestView {
  request: BookingRequestRow;
  lesson: LessonRow | null;
}

const requiredText = (value: string | null | undefined): string => {
  const text = (value ?? '').trim();
  if (!text) throw AppError.validation('A reason is required', { reason: 'reason_required' });
  if (text.length > MAX_RESCHEDULE_COMMENT_LENGTH)
    throw AppError.validation('Text is too long', { max: MAX_RESCHEDULE_COMMENT_LENGTH });
  return text;
};

/**
 * 5.7.4 for students and parents: with an open calendar a *request* for an open slot (always confirmed by the
 * teacher, Р-24; nothing is held, CAL-10), with a closed calendar a *plea* — a message with the reason and no
 * slot. The teacher accepts (the move goes through CAL-01; a taken slot declines the request with «слот занят»
 * and the open slots) or declines with a message. Requests expire with the minimum notice (5.5.5 item 5).
 */
@Injectable()
export class RescheduleRequestUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly lessons: LessonRepository,
    private readonly requests: BookingRequestRepository,
    private readonly profiles: TeacherProfileRepository,
    private readonly links: TeacherStudentRepository,
    private readonly family: FamilyLinkRepository,
    private readonly accounts: AccountRepository,
    private readonly features: FeatureService,
    private readonly openSlots: OpenSlotsQuery,
    private readonly reschedule: RescheduleLessonUseCase,
    private readonly create: CreateLessonUseCase,
    private readonly weekly: WeeklyLimitPolicy,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  /** Whether the student may *request* a slot (open calendar + feature) or only *ask* (5.7.4). */
  async mode(actor: Actor, lessonId: string, childId?: string): Promise<'request' | 'ask'> {
    assertActive(actor);
    const { lesson, studentId } = await this.own(actor, lessonId, childId);
    const link = await this.links.findByPair(lesson.teacherId, studentId);
    const profile = await this.profiles.find(lesson.teacherId);
    if (!link || !profile) return 'ask';
    const open =
      (await this.features.isEnabled(lesson.teacherId, 'calendar.open_booking')) &&
      isCalendarOpenFor(profile, link);
    return open ? 'request' : 'ask';
  }

  async request(actor: Actor, input: RescheduleRequestInput): Promise<BookingRequestRow> {
    assertActive(actor);
    const reason = requiredText(input.reason);
    return this.txm.run(async () => {
      const { lesson, studentId, role } = await this.own(actor, input.lessonId, input.studentId, true);
      if (lesson.groupId)
        throw AppError.validation('A group lesson cannot be moved by a student', { reason: 'group' });
      if ((await this.mode(actor, lesson.id, input.studentId)) !== 'request')
        throw AppError.forbidden('The calendar is closed', { reason: 'calendar_closed' });
      const durationMin = Math.round((lesson.endsAt.getTime() - lesson.startsAt.getTime()) / MINUTE_MS);
      await this.assertOpenSlot(actor, lesson, studentId, input.startsAt, durationMin);
      if ((await this.requests.lockPendingByLesson(lesson.id)).some((r) => r.studentId === studentId))
        throw new AppError('CONFLICT', 'A request about this lesson is already waiting', {
          reason: 'pending_exists',
        });
      const row = await this.requests.insert({
        teacherId: lesson.teacherId,
        studentId,
        kind: 'reschedule',
        lessonId: lesson.id,
        startsAt: input.startsAt,
        endsAt: new Date(input.startsAt.getTime() + durationMin * MINUTE_MS),
        comment: reason,
        createdBy: actor.accountId,
      });
      await this.recordAndAnnounce(actor, role, row, 'requested');
      return row;
    });
  }

  /** Closed calendar: a plea without a slot (5.7.4 «просьба о переносе»); the teacher moves the lesson. */
  async ask(actor: Actor, input: AskInput): Promise<BookingRequestRow> {
    assertActive(actor);
    const reason = requiredText(input.reason);
    return this.txm.run(async () => {
      const { lesson, studentId, role } = await this.own(actor, input.lessonId, input.studentId, true);
      if ((await this.requests.lockPendingByLesson(lesson.id)).some((r) => r.studentId === studentId))
        throw new AppError('CONFLICT', 'A request about this lesson is already waiting', {
          reason: 'pending_exists',
        });
      const row = await this.requests.insert({
        teacherId: lesson.teacherId,
        studentId,
        kind: 'reschedule_ask',
        lessonId: lesson.id,
        startsAt: null,
        endsAt: null,
        comment: reason,
        createdBy: actor.accountId,
      });
      await this.recordAndAnnounce(actor, role, row, 'asked');
      return row;
    });
  }

  /** The teacher's open requests with their lessons (the list screen and the morning digest). */
  async pendingForTeacher(actor: Actor): Promise<RequestView[]> {
    assertRole(actor, 'TEACHER');
    const rows = await this.requests.listPendingByTeacher(actor.accountId);
    const lessons = await this.lessons.findByIds(
      rows.map((r) => r.lessonId).filter((id): id is string => !!id),
    );
    const byId = new Map(lessons.map((l) => [l.id, l]));
    return rows.map((request) => ({
      request,
      lesson: request.lessonId ? (byId.get(request.lessonId) ?? null) : null,
    }));
  }

  /** One request of the teacher (8.0). */
  async view(actor: Actor, requestId: string): Promise<RequestView> {
    assertRole(actor, 'TEACHER');
    const request = await this.requests.findById(requestId);
    if (!request || request.teacherId !== actor.accountId) throw AppError.notFound('request', requestId);
    return { request, lesson: request.lessonId ? await this.lessons.findById(request.lessonId) : null };
  }

  /**
   * Accept → the move through CAL-01 (a taken slot declines the request as `slot_taken` and sends the open
   * slots); decline → the message to the student. A plea (`reschedule_ask`) can only be closed: accepting it means
   * the teacher moves the lesson by hand.
   */
  async decide(actor: Actor, input: DecideInput): Promise<BookingRequestRow> {
    assertRole(actor, 'TEACHER');
    const message = (input.message ?? '').trim();
    if (message.length > MAX_RESCHEDULE_COMMENT_LENGTH)
      throw AppError.validation('Text is too long', { max: MAX_RESCHEDULE_COMMENT_LENGTH });
    const now = this.clock.now();
    return this.txm.run(async () => {
      // lock order: the lesson first, then the request — the same order a move, a request and a plea take
      const peek = await this.requests.findById(input.requestId);
      if (!peek || peek.teacherId !== actor.accountId) throw AppError.notFound('request', input.requestId);
      // a booking decision serialises with new bookings on the teacher's profile row (CAL-10), then the link
      if (peek.kind === 'booking') await this.profiles.find(peek.teacherId, { forUpdate: true });
      if (peek.lessonId) await this.lessons.findById(peek.lessonId, { forUpdate: true });
      const request = await this.requests.findById(input.requestId, { forUpdate: true });
      if (!request || request.status !== 'pending')
        throw new AppError('CONFLICT', 'The request is already decided', { status: request?.status });
      if (!input.accept) {
        if (!message) throw AppError.validation('A message is required', { reason: 'reason_required' });
        return this.close(actor, request, 'declined', 'declined', message, now);
      }
      // a plea has no slot: «accepting» it only acknowledges — the teacher moves the lesson by hand
      if (request.kind === 'reschedule_ask')
        return this.close(actor, request, 'accepted', 'acknowledged', message || null, now);
      // the wanted slot has already started (expiry lag): nothing to accept any more
      if (request.startsAt!.getTime() <= now.getTime())
        return this.close(null, request, 'expired', 'expired', null, now);
      if (request.kind === 'booking') return this.acceptBooking(actor, request, message, now);
      try {
        await this.txm.runSavepoint(() =>
          this.reschedule.execute(actor, {
            lessonId: request.lessonId!,
            startsAt: request.startsAt!,
            durationMin: Math.round((request.endsAt!.getTime() - request.startsAt!.getTime()) / MINUTE_MS),
            comment: message || null,
            acceptedRequest: { id: request.id, studentId: request.studentId },
          }),
        );
      } catch (error) {
        // 5.5.5 item 4: the slot is taken — declined with «слот занят» and the open slots
        if (AppError.is(error, 'LESSON_CONFLICT'))
          return this.close(actor, request, 'declined', 'slot_taken', message || null, now);
        // the lesson is cancelled or reported meanwhile: the request lost its subject
        if (AppError.is(error, 'CONFLICT'))
          return this.close(null, request, 'cancelled', 'lesson_changed', null, now);
        // the lesson already stands at the wanted time (moved by hand): nothing left but to confirm
        if (AppError.is(error, 'VALIDATION_ERROR') && error.details?.['reason'] === 'same_time')
          return this.close(actor, request, 'accepted', 'accepted', message || null, now);
        throw error;
      }
      return this.close(actor, request, 'accepted', 'accepted', message || null, now);
    });
  }

  /**
   * UC-17 step 3 (5.5.5): the lesson is created through CAL-01 (`booking_accepted`); a taken slot or a reached
   * weekly limit declines the request as `slot_taken` / `declined`; pending requests of *other* students that
   * overlap the new lesson are declined with «слот занят» and the open slots.
   */
  private async acceptBooking(
    actor: Actor,
    request: BookingRequestRow,
    message: string,
    now: Date,
  ): Promise<BookingRequestRow> {
    const link = await this.links.findByPair(request.teacherId, request.studentId, { forUpdate: true });
    if (link?.status !== 'active') return this.close(null, request, 'cancelled', 'link_ended', null, now);
    try {
      await this.weekly.assertRoom(link, request.startsAt!);
    } catch (error) {
      if (!AppError.is(error, 'WEEKLY_LIMIT_EXCEEDED')) throw error;
      return this.close(actor, request, 'declined', 'weekly_limit', message || null, now);
    }
    try {
      await this.txm.runSavepoint(() =>
        this.create.execute(actor, {
          target: { studentId: request.studentId },
          startsAt: request.startsAt!,
          durationMin: Math.round((request.endsAt!.getTime() - request.startsAt!.getTime()) / MINUTE_MS),
          createdVia: 'booking_accepted',
          createdBy: request.studentId,
          teacherNotes: request.comment,
        }),
      );
    } catch (error) {
      if (AppError.is(error, 'LESSON_CONFLICT'))
        return this.close(actor, request, 'declined', 'slot_taken', message || null, now);
      throw error;
    }
    const accepted = await this.close(actor, request, 'accepted', 'accepted', message || null, now);
    for (const other of await this.requests.lockPendingOverlapping(
      request.teacherId,
      request.startsAt!,
      request.endsAt!,
      'booking',
    )) {
      await this.close(null, other, 'declined', 'slot_taken', null, now);
    }
    return accepted;
  }

  /** 5.5.5 item 5: a request whose slot no longer satisfies the minimum notice expires; the student is told. */
  async expire(pageSize = 200): Promise<number> {
    const now = this.clock.now();
    const horizon = new Date(now.getTime() + MAX_MIN_NOTICE_HOURS * HOUR_MS);
    let expired = 0;
    let after: { startsAt: Date; id: string } | undefined;
    const notice = new Map<string, number>();
    for (;;) {
      // one transaction per page: the locks never span hundreds of rows at once (L-1)
      const { count, last, size } = await this.txm.run(async () => {
        const page = await this.requests.lockPendingStartingBefore(horizon, pageSize, after);
        let count = 0;
        for (const request of page) {
          let minNotice = notice.get(request.teacherId);
          if (minNotice === undefined) {
            const profile = await this.profiles.find(request.teacherId);
            minNotice = profile?.bookingRules.minNoticeHours ?? DEFAULT_BOOKING_RULES.minNoticeHours;
            notice.set(request.teacherId, minNotice);
          }
          if (request.startsAt!.getTime() - now.getTime() >= minNotice * HOUR_MS) continue;
          await this.close(null, request, 'expired', 'expired', null, now);
          count += 1;
        }
        const tail = page.at(-1);
        return {
          count,
          last: tail ? { startsAt: tail.startsAt!, id: tail.id } : undefined,
          size: page.length,
        };
      });
      expired += count;
      if (!last || size < pageSize) return expired;
      after = last;
    }
  }

  private async close(
    actor: Actor | null,
    request: BookingRequestRow,
    status: 'accepted' | 'declined' | 'expired' | 'cancelled',
    reason: string,
    message: string | null,
    now: Date,
  ): Promise<BookingRequestRow> {
    const decided = await this.requests.decide(request.id, {
      status,
      decidedBy: actor?.accountId ?? null,
      decisionMessage: message,
      decisionReason: reason,
      decidedAt: now,
    });
    if (!decided) throw new AppError('CONFLICT', 'The request is already decided');
    if (actor)
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: 'TEACHER',
        action: `booking_request.${status}`,
        entityType: 'booking_request',
        entityId: request.id,
        after: { reason, kind: request.kind, hasMessage: !!message },
        source: actor.source,
        ip: actor.ip,
      });
    const openSlots = reason === 'slot_taken' ? await this.openSlotsFor(request) : [];
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
        status,
        reason,
        message,
        startsAt: request.startsAt?.toISOString() ?? null,
        openSlots,
      },
    });
    return decided;
  }

  /** The lesson the student takes part in (or the parent's child does), with an active link (8.0). */
  private async own(
    actor: Actor,
    lessonId: string,
    childId: string | undefined,
    forUpdate = false,
  ): Promise<{ lesson: LessonRow; studentId: string; role: 'STUDENT' | 'PARENT' }> {
    const lesson = await this.lessons.findById(lessonId, { forUpdate });
    if (!lesson) throw AppError.notFound('lesson', lessonId);
    const participants = (await this.lessons.listParticipants(lesson.id)).map((p) => p.studentId);
    let studentId: string;
    let role: 'STUDENT' | 'PARENT';
    if (actor.roles.includes('PARENT') && childId && childId !== actor.accountId) {
      if (!(await this.family.findActive(actor.accountId, childId)))
        throw AppError.notFound('lesson', lessonId);
      studentId = childId;
      role = 'PARENT';
    } else if (actor.roles.includes('STUDENT')) {
      studentId = actor.accountId;
      role = 'STUDENT';
    } else throw AppError.notFound('lesson', lessonId);
    if (!participants.includes(studentId)) throw AppError.notFound('lesson', lessonId);
    if (lesson.status !== 'scheduled' || lesson.startsAt.getTime() <= this.clock.now().getTime())
      throw new AppError('CONFLICT', 'The lesson cannot be moved any more', { status: lesson.status });
    const link = await this.links.findByPair(lesson.teacherId, studentId);
    if (link?.status !== 'active')
      throw new AppError('LINK_NOT_ACTIVE', 'No active link with the teacher', {
        teacherId: lesson.teacherId,
      });
    if ((await this.accounts.findById(lesson.teacherId))?.status === 'blocked')
      throw new AppError('LINK_NOT_ACTIVE', 'The teacher is blocked', { teacherId: lesson.teacherId }); // ACC-04
    return { lesson, studentId, role };
  }

  /** The wanted start must be one of the open slots the student is offered right now (5.7.4, CAL-08). */
  private async assertOpenSlot(
    actor: Actor,
    lesson: LessonRow,
    studentId: string,
    startsAt: Date,
    durationMin: number,
  ): Promise<void> {
    const student: Actor = {
      accountId: studentId,
      roles: ['STUDENT'],
      status: 'active',
      source: actor.source,
    };
    const { slots } = await this.openSlots.slots(student, {
      teacherId: lesson.teacherId,
      range: { start: new Date(startsAt.getTime() - DAY_MS), end: new Date(startsAt.getTime() + DAY_MS) },
      durationMin,
      excludeLessonId: lesson.id, // the lesson's own time does not block a shift (M-2)
    });
    if (!slots.some((s) => s.start.getTime() === startsAt.getTime()))
      throw AppError.validation('The time is not an open slot', { reason: 'not_open' });
  }

  /** Open slots the student may choose instead (the «слот занят» message), the next two weeks, ISO strings. */
  private async openSlotsFor(request: BookingRequestRow): Promise<string[]> {
    if (!request.startsAt || !request.endsAt) return [];
    const now = this.clock.now();
    const student: Actor = {
      accountId: request.studentId,
      roles: ['STUDENT'],
      status: 'active',
      source: 'system',
    };
    try {
      const { slots } = await this.openSlots.slots(student, {
        teacherId: request.teacherId,
        range: { start: now, end: new Date(now.getTime() + 14 * DAY_MS) },
        durationMin: Math.round((request.endsAt.getTime() - request.startsAt.getTime()) / MINUTE_MS),
        ...(request.lessonId ? { excludeLessonId: request.lessonId } : {}),
      });
      return slots.slice(0, 8).map((s) => s.start.toISOString());
    } catch (error) {
      if (AppError.is(error)) return []; // calendar closed meanwhile, duration no longer offered, …
      throw error;
    }
  }

  private async recordAndAnnounce(
    actor: Actor,
    role: 'STUDENT' | 'PARENT',
    row: BookingRequestRow,
    action: 'requested' | 'asked',
  ): Promise<void> {
    await this.audit.record({
      actorId: actor.accountId,
      actorRole: role,
      action: `booking_request.${action}`,
      entityType: 'booking_request',
      entityId: row.id,
      after: { kind: row.kind, lessonId: row.lessonId, startsAt: row.startsAt?.toISOString() ?? null },
      source: actor.source,
      ip: actor.ip,
    });
    await this.outbox.publish({
      type: 'booking.requested',
      aggregateType: 'booking_request',
      aggregateId: row.id,
      payload: {
        requestId: row.id,
        teacherId: row.teacherId,
        studentId: row.studentId,
        kind: row.kind,
        lessonId: row.lessonId,
        startsAt: row.startsAt?.toISOString() ?? null,
        endsAt: row.endsAt?.toISOString() ?? null,
        comment: row.comment,
        byAccountId: actor.accountId,
        byRole: role,
      },
    });
  }
}

/** The largest minimum notice a teacher may set (hours); the expiry sweep looks this far ahead. */
export const MAX_MIN_NOTICE_HOURS = 24 * 14;
