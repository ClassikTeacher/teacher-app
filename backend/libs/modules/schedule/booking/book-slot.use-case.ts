import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock, DAY_MS, MINUTE_MS } from '@shared/time/clock.js';
import { type Actor, assertActive } from '@modules/access/actor.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import type { TeacherProfileRow, TeacherStudentRow } from '@modules/people/schema.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { FeatureService } from '@modules/access/features/feature.service.js';
import {
  DEFAULT_BOOKING_RULES,
  isCalendarOpenFor,
  OpenSlotsQuery,
} from '../availability/open-slots.query.js';
import { CreateLessonUseCase } from '../lessons/create-lesson.use-case.js';
import { BookingRequestRepository } from '../requests/booking-request.repository.js';
import type { BookingRequestRow, LessonRow } from '../schema.js';
import { WeeklyLimitPolicy } from './weekly-limit.policy.js';

export const MAX_BOOKING_COMMENT_LENGTH = 500;

export interface BookSlotInput {
  teacherId: string;
  startsAt: Date;
  durationMin: number;
  comment?: string | null;
}

export type BookSlotResult =
  { kind: 'lesson'; lesson: LessonRow } | { kind: 'request'; request: BookingRequestRow };

/**
 * UC-16 (5.5.5): a student books an open slot. `auto` → the lesson is created at once with everyone's occupancy
 * (CAL-01; a lost race is LESSON_CONFLICT, 2а); `manual` → a `booking` request that holds nothing (Р-22), at most
 * N pending per overlapping slot (1в). The weekly limit of the link applies in both modes (PPL-06, 1б).
 */
@Injectable()
export class BookSlotUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly profiles: TeacherProfileRepository,
    private readonly links: TeacherStudentRepository,
    private readonly accounts: AccountRepository,
    private readonly openSlots: OpenSlotsQuery,
    private readonly features: FeatureService,
    private readonly weekly: WeeklyLimitPolicy,
    private readonly create: CreateLessonUseCase,
    private readonly requests: BookingRequestRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  /** Teachers whose calendar is open for this student right now (the «Записаться» list). */
  async openTeachers(actor: Actor): Promise<TeacherStudentRow[]> {
    assertActive(actor);
    if (!actor.roles.includes('STUDENT')) throw AppError.forbidden('Not a student');
    const links = await this.links.listByStudent(actor.accountId, ['active']);
    const open: TeacherStudentRow[] = [];
    const teachers = await this.accounts.findByIds(links.map((l) => l.teacherId));
    for (const link of links) {
      if (teachers.find((t) => t.id === link.teacherId)?.status !== 'active') continue; // ACC-04 (H-2)
      const profile = await this.profiles.find(link.teacherId);
      if (!profile || !isCalendarOpenFor(profile, link)) continue;
      if (await this.features.isEnabled(link.teacherId, 'calendar.open_booking')) open.push(link);
    }
    return open;
  }

  async book(actor: Actor, input: BookSlotInput): Promise<BookSlotResult> {
    assertActive(actor);
    if (!actor.roles.includes('STUDENT')) throw AppError.forbidden('Not a student');
    const comment = (input.comment ?? '').trim();
    if (comment.length > MAX_BOOKING_COMMENT_LENGTH)
      throw AppError.validation('Comment is too long', { max: MAX_BOOKING_COMMENT_LENGTH });
    const now = this.clock.now();
    return this.txm.run(async () => {
      // lock order everywhere: the teacher's profile (serialises the pending-per-slot count, CAL-10), then the link
      const profile = await this.profiles.find(input.teacherId, { forUpdate: true });
      if (!profile) throw AppError.notFound('teacher', input.teacherId);
      const link = await this.links.findByPair(input.teacherId, actor.accountId, { forUpdate: true });
      if (link?.status !== 'active') throw AppError.notFound('teacher', input.teacherId);
      await this.assertOpenSlot(actor, input); // open calendar, feature, horizon, notice, duration, free (CAL-08)
      await this.weekly.assertRoom(link, input.startsAt); // PPL-06 in both modes
      if (profile.bookingConfirmation === 'auto')
        return { kind: 'lesson', lesson: await this.createNow(actor, input, comment) };
      return { kind: 'request', request: await this.requestSlot(actor, input, profile, comment, now) };
    });
  }

  private async createNow(actor: Actor, input: BookSlotInput, comment: string): Promise<LessonRow> {
    const teacher: Actor = {
      accountId: input.teacherId,
      roles: ['TEACHER'],
      status: 'active',
      source: actor.source,
    };
    const { lesson } = await this.create.execute(teacher, {
      target: { studentId: actor.accountId },
      startsAt: input.startsAt,
      durationMin: input.durationMin,
      createdVia: 'student_booking',
      createdBy: actor.accountId,
      teacherNotes: comment || null, // the student's note is for the teacher's eyes (5.6.1)
    });
    await this.audit.record({
      actorId: actor.accountId,
      actorRole: 'STUDENT',
      action: 'lesson.booked',
      entityType: 'lesson',
      entityId: lesson.id,
      after: {
        teacherId: input.teacherId,
        startsAt: input.startsAt.toISOString(),
        durationMin: input.durationMin,
      },
      source: actor.source,
      ip: actor.ip,
    });
    return lesson;
  }

  /** 5.5.5 «Режим с подтверждением»: a request, at most N pending on overlapping time (Р-22). */
  private async requestSlot(
    actor: Actor,
    input: BookSlotInput,
    profile: TeacherProfileRow,
    comment: string,
    now: Date,
  ): Promise<BookingRequestRow> {
    const endsAt = new Date(input.startsAt.getTime() + input.durationMin * MINUTE_MS);
    const maxPending = profile.bookingRules.maxPendingPerSlot ?? DEFAULT_BOOKING_RULES.maxPendingPerSlot;
    const pending = await this.requests.lockPendingOverlapping(
      input.teacherId,
      input.startsAt,
      endsAt,
      'booking',
    );
    if (pending.some((r) => r.studentId === actor.accountId))
      throw new AppError('CONFLICT', 'You already asked for this time', { reason: 'pending_exists' });
    if (pending.length >= maxPending)
      throw new AppError('SLOT_REQUESTS_FULL', 'Too many requests for this time', { max: maxPending });
    const row = await this.requests.insert({
      teacherId: input.teacherId,
      studentId: actor.accountId,
      kind: 'booking',
      lessonId: null,
      startsAt: input.startsAt,
      endsAt,
      comment: comment || null,
      createdBy: actor.accountId,
    });
    await this.audit.record({
      actorId: actor.accountId,
      actorRole: 'STUDENT',
      action: 'booking_request.requested',
      entityType: 'booking_request',
      entityId: row.id,
      after: { kind: 'booking', teacherId: input.teacherId, startsAt: input.startsAt.toISOString() },
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
        kind: 'booking',
        lessonId: null,
        startsAt: row.startsAt!.toISOString(),
        endsAt: row.endsAt!.toISOString(),
        comment: row.comment,
        byAccountId: actor.accountId,
        byRole: 'STUDENT',
        createdAt: now.toISOString(),
      },
    });
    return row;
  }

  /** The start must be one of the open slots offered right now for this duration (CAL-08, 5.5.5). */
  private async assertOpenSlot(actor: Actor, input: BookSlotInput): Promise<void> {
    const { slots } = await this.openSlots.slots(actor, {
      teacherId: input.teacherId,
      range: {
        start: new Date(input.startsAt.getTime() - DAY_MS),
        end: new Date(input.startsAt.getTime() + DAY_MS),
      },
      durationMin: input.durationMin,
    });
    if (!slots.some((s) => s.start.getTime() === input.startsAt.getTime()))
      throw AppError.validation('The time is not an open slot', { reason: 'not_open' });
  }
}
