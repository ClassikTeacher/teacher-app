import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { type Actor, assertActive } from '@modules/access/actor.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { MessageTemplateRepository } from '@modules/people/message-template.repository.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import type { TeacherProfileRow } from '@modules/people/schema.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { LessonRepository } from '../lessons/lesson.repository.js';
import { OccupancyService } from '../occupancy/occupancy.service.js';
import type { CancellationRow, CancelRole, LessonRow } from '../schema.js';
import { type CancelCheck, checkCancel, isLateCancel, normalizeCancelReason } from './cancel.rules.js';
import { CancellationRepository } from './cancellation.repository.js';

export type CancelAs = 'TEACHER' | 'STUDENT' | 'PARENT';

export interface CancelLessonInput {
  lessonId: string;
  reason: string;
  templateId?: string | null;
  /** A parent cancels on behalf of this child (Р-25); ignored for other roles. */
  studentId?: string;
  /** The role the actor acts in (an account may hold several); omitted → teacher of the lesson, else student/parent. */
  as?: CancelAs;
}

export interface CancelLessonResult {
  lesson: LessonRow;
  cancellation: CancellationRow;
  outcome: CancelCheck['outcome'];
  isLate: boolean;
}

/** What `cancelLocked` needs to know about the initiator; system cancellations (5.7.6) pass `SYSTEM`. */
export interface CancelContext {
  cancellation: CancellationRow;
  role: CancelRole;
  actorId: string | null;
  source: Actor['source'];
  ip?: string | null;
}

type UserRole = CancelAs;

interface Resolved {
  lesson: LessonRow;
  profile: TeacherProfileRow;
  role: UserRole;
  studentId: string | null;
}

/**
 * UC-20 / UC-21 (5.7.3): one lesson cancelled by the teacher, the student or a parent, or an absence notice in a
 * group lesson (CNL-03). Everything happens in one transaction: status, occupancy, history, the cancellation
 * record (CNL-08) and the domain event the notifications handler turns into messages (CNL-05). Bulk (M4-02) and
 * system (M4-06) cancellations reuse `cancelLocked` / `absenceLocked` inside their own transactions.
 */
@Injectable()
export class CancelLessonUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly lessons: LessonRepository,
    private readonly occupancy: OccupancyService,
    private readonly cancellations: CancellationRepository,
    private readonly profiles: TeacherProfileRepository,
    private readonly links: TeacherStudentRepository,
    private readonly family: FamilyLinkRepository,
    private readonly templates: MessageTemplateRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  /** Preview for the confirmation screen: what will happen and whether it counts as late (UC-20 step 3). */
  async preview(actor: Actor, lessonId: string, childId?: string, as?: CancelAs): Promise<CancelCheck> {
    assertActive(actor);
    const { lesson, profile, role, studentId } = await this.resolve(actor, lessonId, childId, false, as);
    const check = checkCancel({ role, lesson, profile, now: this.clock.now() });
    if (check.outcome === 'absence' && studentId) await this.assertNotReported(lesson.id, studentId);
    return check;
  }

  private async assertNotReported(lessonId: string, studentId: string): Promise<void> {
    const participant = (await this.lessons.listParticipants(lessonId)).find(
      (p) => p.studentId === studentId,
    );
    if (participant?.attendance === 'absent_notified')
      throw new AppError('CONFLICT', 'Absence is already reported', { reason: 'already_reported' });
  }

  async execute(actor: Actor, input: CancelLessonInput): Promise<CancelLessonResult> {
    assertActive(actor);
    const reason = normalizeCancelReason(input.reason);
    const now = this.clock.now();
    return this.txm.run(async () => {
      const { lesson, profile, role, studentId } = await this.resolve(
        actor,
        input.lessonId,
        input.studentId,
        true,
        input.as,
      );
      const templateId = await this.ownTemplate(actor.accountId, input.templateId);
      const check = checkCancel({ role, lesson, profile, now });
      const cancellation = await this.cancellations.insert({
        initiatorId: actor.accountId,
        initiatorRole: role,
        onBehalfOfStudentId: role === 'PARENT' ? studentId : null,
        kind: 'single',
        reason,
        templateId,
        createdAt: now,
      });
      const context: CancelContext = {
        cancellation,
        role,
        actorId: actor.accountId,
        source: actor.source,
        ip: actor.ip,
      };
      const updated =
        check.outcome === 'absence'
          ? await this.absenceLocked(lesson, studentId!, context, check.isLate, now)
          : await this.cancelLocked(lesson, context, check.isLate, now);
      return { lesson: updated, cancellation, outcome: check.outcome, isLate: check.isLate };
    });
  }

  /** CNL-08: a template is recorded only when it is the actor's own live `cancel_reason` template. */
  async ownTemplate(ownerId: string, templateId: string | null | undefined): Promise<string | null> {
    if (!templateId) return null;
    const row = await this.templates.findById(templateId);
    if (!row || row.ownerId !== ownerId || row.kind !== 'cancel_reason' || row.archivedAt)
      throw AppError.validation('Unknown template', { templateId });
    return row.id;
  }

  /** Frees one participant's time of a lesson that stays (a student leaving a group lesson). */
  releaseFor(lessonId: string, studentId: string): Promise<number> {
    return this.occupancy.releaseLesson(lessonId, studentId);
  }

  /** Pure helper for previews of many lessons (bulk, M4-02). */
  isLate(lesson: Pick<LessonRow, 'startsAt'>, profile: Pick<TeacherProfileRow, 'lateCancelHours'>): boolean {
    return isLateCancel(lesson, profile.lateCancelHours, this.clock.now());
  }

  /**
   * Cancels a lesson inside the caller's transaction; the caller must hold the row lock (FOR UPDATE), which makes
   * the status check authoritative. Status, time of everyone released (CNL-04), history, item, audit and
   * `lesson.cancelled`. Reminders are dropped by the notifications handler.
   */
  async cancelLocked(lesson: LessonRow, ctx: CancelContext, isLate: boolean, now: Date): Promise<LessonRow> {
    if (lesson.status !== 'scheduled')
      throw new AppError('CONFLICT', 'Lesson is not scheduled any more', { status: lesson.status });
    const updated = await this.lessons.update(
      lesson.id,
      { status: 'cancelled', cancelledAt: now, cancellationId: ctx.cancellation.id },
      { bumpVersion: true },
    );
    await this.occupancy.releaseLesson(lesson.id);
    await this.cancellations.insertItems([
      {
        cancellationId: ctx.cancellation.id,
        lessonId: lesson.id,
        action: 'cancelled',
        isLate,
        createdAt: now,
      },
    ]);
    const participants = (await this.lessons.listParticipants(lesson.id)).map((p) => p.studentId);
    const summary = {
      role: ctx.role,
      isLate,
      cancellationId: ctx.cancellation.id,
      source: ctx.cancellation.source,
    };
    await this.lessons.addEvent({
      lessonId: lesson.id,
      type: 'cancelled',
      actorId: ctx.actorId,
      payload: summary,
      at: now,
    });
    await this.audit.record({
      actorId: ctx.actorId,
      actorRole: ctx.role === 'SYSTEM' ? null : ctx.role,
      action: 'lesson.cancelled',
      entityType: 'lesson',
      entityId: lesson.id,
      before: { status: lesson.status },
      after: { status: 'cancelled', ...summary, reasonLength: ctx.cancellation.reason.length },
      source: ctx.source,
      ip: ctx.ip,
    });
    await this.outbox.publish({
      type: 'lesson.cancelled',
      aggregateType: 'lesson',
      aggregateId: lesson.id,
      payload: {
        lessonId: lesson.id,
        teacherId: lesson.teacherId,
        groupId: lesson.groupId,
        subjectId: lesson.subjectId,
        studentIds: participants,
        startsAt: lesson.startsAt.toISOString(),
        endsAt: lesson.endsAt.toISOString(),
        reason: ctx.cancellation.source ?? 'user',
        message: ctx.cancellation.reason,
        byAccountId: ctx.actorId,
        byRole: ctx.role,
        onBehalfOfStudentId: ctx.cancellation.onBehalfOfStudentId,
        cancellationId: ctx.cancellation.id,
        kind: ctx.cancellation.kind,
        isLate,
        version: updated.version,
      },
    });
    return updated;
  }

  /** CNL-03: the lesson stays, the student is marked «absent, warned» and their time is freed. */
  async absenceLocked(
    lesson: LessonRow,
    studentId: string,
    ctx: CancelContext,
    isLate: boolean,
    now: Date,
  ): Promise<LessonRow> {
    const participant = (await this.lessons.listParticipants(lesson.id)).find(
      (p) => p.studentId === studentId,
    );
    if (!participant) throw AppError.notFound('lesson', lesson.id);
    await this.assertNotReported(lesson.id, studentId);
    await this.lessons.updateParticipant(participant.id, {
      attendance: 'absent_notified',
      absenceReason: ctx.cancellation.reason,
    });
    await this.occupancy.releaseLesson(lesson.id, studentId);
    await this.cancellations.insertItems([
      {
        cancellationId: ctx.cancellation.id,
        lessonId: lesson.id,
        action: 'absence',
        studentId,
        isLate,
        createdAt: now,
      },
    ]);
    const summary = { studentId, role: ctx.role, isLate, cancellationId: ctx.cancellation.id };
    await this.lessons.addEvent({
      lessonId: lesson.id,
      type: 'absence_notified',
      actorId: ctx.actorId,
      payload: summary,
      at: now,
    });
    await this.audit.record({
      actorId: ctx.actorId,
      actorRole: ctx.role === 'SYSTEM' ? null : ctx.role,
      action: 'lesson.absence',
      entityType: 'lesson',
      entityId: lesson.id,
      after: { ...summary, reasonLength: ctx.cancellation.reason.length },
      source: ctx.source,
      ip: ctx.ip,
    });
    await this.outbox.publish({
      type: 'lesson.absence',
      aggregateType: 'lesson',
      aggregateId: lesson.id,
      payload: {
        lessonId: lesson.id,
        teacherId: lesson.teacherId,
        groupId: lesson.groupId,
        studentId,
        startsAt: lesson.startsAt.toISOString(),
        message: ctx.cancellation.reason,
        byAccountId: ctx.actorId,
        byRole: ctx.role,
        onBehalfOfStudentId: ctx.cancellation.onBehalfOfStudentId,
        cancellationId: ctx.cancellation.id,
        kind: ctx.cancellation.kind,
        isLate,
      },
    });
    return lesson;
  }

  /**
   * The lesson as the actor may touch it (8.0): the teacher's own; a student's own lesson through an active
   * link; a parent's child's lesson through an active family link and the child's active link with the teacher.
   */
  private async resolve(
    actor: Actor,
    lessonId: string,
    childId: string | undefined,
    forUpdate: boolean,
    as?: CancelAs,
  ): Promise<Resolved> {
    const lesson = await this.lessons.findById(lessonId, { forUpdate });
    if (!lesson) throw AppError.notFound('lesson', lessonId);
    const profile = await this.profiles.find(lesson.teacherId);
    if (!profile) throw AppError.notFound('teacher profile', lesson.teacherId);
    const may = (role: CancelAs): boolean => actor.roles.includes(role) && (as === undefined || as === role);
    if (may('TEACHER') && lesson.teacherId === actor.accountId)
      return { lesson, profile, role: 'TEACHER', studentId: null };
    if (as === 'TEACHER') throw AppError.notFound('lesson', lessonId);
    const participants = (await this.lessons.listParticipants(lesson.id)).map((p) => p.studentId);
    let role: 'STUDENT' | 'PARENT';
    let studentId: string;
    if (may('PARENT') && childId && childId !== actor.accountId) {
      if (!(await this.family.findActive(actor.accountId, childId)))
        throw AppError.notFound('lesson', lessonId);
      role = 'PARENT';
      studentId = childId;
    } else if (may('STUDENT')) {
      role = 'STUDENT';
      studentId = actor.accountId;
    } else throw AppError.notFound('lesson', lessonId);
    if (!participants.includes(studentId)) throw AppError.notFound('lesson', lessonId);
    const link = await this.links.findByPair(lesson.teacherId, studentId);
    if (link?.status !== 'active')
      throw new AppError('LINK_NOT_ACTIVE', 'No active link with the teacher', {
        teacherId: lesson.teacherId,
      });
    return { lesson, profile, role, studentId };
  }
}
