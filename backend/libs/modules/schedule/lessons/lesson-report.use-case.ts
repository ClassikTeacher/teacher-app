import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { type Actor, assertRole, primaryRole } from '@modules/access/actor.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { ATTENDANCE, type Attendance, type LessonRow } from '../schema.js';
import { LessonRepository } from './lesson.repository.js';
import { isOver, MAX_COMMENT_LENGTH, MAX_NOT_HELD_REASON_LENGTH, MAX_TOPIC_LENGTH } from './lesson.rules.js';

/** Stored when the teacher taps the quick «Неявка» button (kept as data, not a UI label). */
export const NO_SHOW_REASON = 'Неявка';

export interface AttendanceInput {
  studentId: string;
  attendance: Attendance;
  absenceReason?: string | null;
}

export interface CompleteLessonInput {
  /** The topic, or `true` to take the planned one ("Тема как планировали"). */
  topic: string | true;
  attendance: readonly AttendanceInput[];
  sharedComment?: string | null;
  teacherNotes?: string | null;
}

const text = (value: string | null | undefined, max: number, field: string): string | null => {
  if (value === undefined || value === null) return null;
  const clean = value.trim();
  if (clean.length > max) throw AppError.validation(`${field} is too long`, { max });
  return clean || null;
};

/**
 * UC-24 / 5.6.4: the teacher's report after the lesson. `completed` needs a topic and the attendance of every
 * participant (LES-02); «Ученик не пришёл» makes it `not_held` with a reason. Both are allowed once the lesson
 * is over, from `awaiting_report` (or `scheduled` when the worker has not swept it yet). Grades, homework and
 * materials in the report arrive with M5/M6.
 */
@Injectable()
export class LessonReportUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly lessons: LessonRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  async complete(actor: Actor, lessonId: string, input: CompleteLessonInput): Promise<LessonRow> {
    assertRole(actor, 'TEACHER');
    const sharedComment = text(input.sharedComment, MAX_COMMENT_LENGTH, 'sharedComment');
    const teacherNotes = text(input.teacherNotes, MAX_COMMENT_LENGTH, 'teacherNotes');
    const now = this.clock.now();
    return this.txm.run(async () => {
      const lesson = await this.reportable(actor, lessonId, now, 'ended');
      const topic = input.topic === true ? lesson.plannedTopic : text(input.topic, MAX_TOPIC_LENGTH, 'topic');
      if (!topic)
        throw new AppError('VALIDATION_ERROR', 'A topic is required to complete the lesson', {
          reason: 'topic_required',
        });
      const participants = await this.lessons.listParticipants(lesson.id);
      const given = new Map(input.attendance.map((a) => [a.studentId, a]));
      for (const p of participants) {
        const a = given.get(p.studentId);
        if (!a || !ATTENDANCE.includes(a.attendance))
          throw new AppError('VALIDATION_ERROR', 'Attendance of every participant is required', {
            reason: 'attendance_required',
            studentId: p.studentId,
          });
        await this.lessons.updateParticipant(p.id, {
          attendance: a.attendance,
          absenceReason: a.attendance.startsWith('absent')
            ? text(a.absenceReason, MAX_NOT_HELD_REASON_LENGTH, 'absenceReason')
            : null,
        });
      }
      const updated = await this.lessons.update(lesson.id, {
        status: 'completed',
        topic,
        sharedComment: sharedComment ?? lesson.sharedComment,
        teacherNotes: teacherNotes ?? lesson.teacherNotes,
        reportedAt: now,
      });
      const summary = {
        from: lesson.status,
        attendance: Object.fromEntries(input.attendance.map((a) => [a.studentId, a.attendance])),
        hasComment: !!sharedComment,
      };
      await this.lessons.addEvent({
        lessonId: lesson.id,
        type: 'completed',
        actorId: actor.accountId,
        payload: summary,
        at: now,
      });
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: primaryRole(actor),
        action: 'lesson.completed',
        entityType: 'lesson',
        entityId: lesson.id,
        before: { status: lesson.status },
        after: { status: 'completed', topicLength: topic.length, ...summary },
        source: actor.source,
        ip: actor.ip,
      });
      await this.outbox.publish({
        type: 'lesson.completed',
        aggregateType: 'lesson',
        aggregateId: lesson.id,
        payload: {
          lessonId: lesson.id,
          teacherId: lesson.teacherId,
          studentIds: participants.map((p) => p.studentId),
          topic,
          sharedComment: sharedComment ?? lesson.sharedComment ?? '',
          attendance: summary.attendance,
        },
      });
      return updated;
    });
  }

  /** UC-24 2а: the lesson did not take place (no-show and the like); the reason is mandatory. */
  async notHeld(actor: Actor, lessonId: string, reason: string): Promise<LessonRow> {
    assertRole(actor, 'TEACHER');
    const clean = text(reason, MAX_NOT_HELD_REASON_LENGTH, 'reason');
    if (!clean) throw new AppError('VALIDATION_ERROR', 'A reason is required', { reason: 'reason_required' });
    const now = this.clock.now();
    return this.txm.run(async () => {
      const lesson = await this.reportable(actor, lessonId, now, 'started'); // LES-03 / Р-32: once it began
      const updated = await this.lessons.update(lesson.id, {
        status: 'not_held',
        notHeldReason: clean,
        reportedAt: now,
      });
      await this.lessons.addEvent({
        lessonId: lesson.id,
        type: 'not_held',
        actorId: actor.accountId,
        payload: { from: lesson.status },
        at: now,
      });
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: primaryRole(actor),
        action: 'lesson.not_held',
        entityType: 'lesson',
        entityId: lesson.id,
        before: { status: lesson.status },
        after: { status: 'not_held', reasonLength: clean.length },
        source: actor.source,
        ip: actor.ip,
      });
      const participants = await this.lessons.listParticipants(lesson.id);
      await this.outbox.publish({
        type: 'lesson.not_held',
        aggregateType: 'lesson',
        aggregateId: lesson.id,
        payload: {
          lessonId: lesson.id,
          teacherId: lesson.teacherId,
          studentIds: participants.map((p) => p.studentId),
        },
      });
      return updated;
    });
  }

  /**
   * The teacher's own lesson, not yet reported, locked for the change (8.0). `completed` needs the lesson to be
   * over; «не состоялось» is allowed as soon as it started (LES-03, Р-32).
   */
  private async reportable(
    actor: Actor,
    lessonId: string,
    now: Date,
    after: 'ended' | 'started',
  ): Promise<LessonRow> {
    const lesson = await this.lessons.findById(lessonId, { forUpdate: true });
    if (!lesson || lesson.teacherId !== actor.accountId) throw AppError.notFound('lesson', lessonId);
    if (lesson.status === 'completed' || lesson.status === 'not_held')
      throw new AppError('CONFLICT', 'The lesson is already reported', { status: lesson.status });
    if (lesson.status === 'cancelled')
      throw new AppError('CONFLICT', 'The lesson is cancelled', { status: lesson.status });
    const ready = after === 'ended' ? isOver(lesson, now) : lesson.startsAt.getTime() <= now.getTime();
    if (!ready) throw new AppError('CONFLICT', 'The lesson is not over yet', { reason: 'not_over' });
    return lesson;
  }
}
