import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock, DAY_MS } from '@shared/time/clock.js';
import { type Actor, assertRole } from '@modules/access/actor.js';
import { FeatureService } from '@modules/access/features/feature.service.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { FileTypeRepository } from '@modules/people/file-type.repository.js';
import { GroupRepository } from '@modules/people/groups/group.repository.js';
import { MaterialRepository } from '@modules/content/material.repository.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { LessonRepository } from '@modules/schedule/lessons/lesson.repository.js';
import { AssignmentRepository } from './assignment.repository.js';
import {
  dueFor,
  type DueResult,
  MAX_ASSIGNMENT_BODY_LENGTH,
  MAX_ASSIGNMENT_TITLE_LENGTH,
  normalizeRules,
} from './homework.rules.js';
import type {
  AssignmentRow,
  AssignmentTargetRow,
  DueMode,
  Grading,
  SubmissionMode,
  SubmissionRules,
  TargetStatus,
} from './schema.js';

/** Statuses a due change or a withdrawal may touch (5.10.2): not yet handed in. */
const RECOMPUTABLE: readonly TargetStatus[] = ['assigned', 'overdue', 'returned'];

/** How far ahead «к следующему занятию» looks for a lesson. */
export const NEXT_LESSON_HORIZON_DAYS = 90;

export interface AssignmentInput {
  title: string;
  body?: string | null;
  dueMode: DueMode;
  dueAt?: Date | null;
  assignedLessonId?: string | null;
  checkLessonId?: string | null;
  collectionId?: string | null;
  submissionMode: SubmissionMode;
  submissionRules?: Partial<SubmissionRules> | null;
  grading?: Grading | null;
  /** Addressees: students and/or groups (5.10.1 «Кому»). */
  studentIds?: string[];
  groupIds?: string[];
}

const text = (
  value: string | null | undefined,
  max: number,
  field: string,
  required = false,
): string | null => {
  const clean = (value ?? '').trim();
  if (!clean) {
    if (required) throw AppError.validation(`${field} is required`, { field });
    return null;
  }
  if (clean.length > max) throw AppError.validation(`${field} is too long`, { field, max });
  return clean;
};

/**
 * UC-26 (5.10.1): the teacher's assignment — draft → published (targets with their own due dates) → closed.
 * Targets of a group follow its membership while the assignment is published (AssignmentEventsHandler).
 */
@Injectable()
export class AssignmentsUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly repo: AssignmentRepository,
    private readonly links: TeacherStudentRepository,
    private readonly groups: GroupRepository,
    private readonly lessons: LessonRepository,
    private readonly materials: MaterialRepository,
    private readonly fileTypes: FileTypeRepository,
    private readonly features: FeatureService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  /** Creates the assignment and, unless `draft`, publishes it in the same transaction. */
  async create(
    actor: Actor,
    input: AssignmentInput,
    options: { draft?: boolean } = {},
  ): Promise<AssignmentRow> {
    assertRole(actor, 'TEACHER');
    await this.features.assertEnabled(actor.accountId, 'homework');
    const title = text(input.title, MAX_ASSIGNMENT_TITLE_LENGTH, 'title', true)!;
    const body = text(input.body, MAX_ASSIGNMENT_BODY_LENGTH, 'body');
    if (input.dueMode === 'fixed' && !input.dueAt)
      throw AppError.validation('dueAt is required for a fixed due date');
    if (input.dueMode === 'fixed' && input.dueAt!.getTime() <= this.clock.now().getTime())
      throw AppError.validation('dueAt must be in the future', { reason: 'due_in_past' });
    if (input.submissionMode === 'files' || input.submissionMode === 'files_text')
      await this.features.assertEnabled(actor.accountId, 'homework.submissions');
    const platform = (await this.fileTypes.listAllowed()).map((t) => t.ext);
    const rules = normalizeRules(input.submissionRules, platform);
    const grading: Grading = input.grading ?? { kind: 'none' };
    const studentIds = [...new Set(input.studentIds ?? [])];
    const groupIds = [...new Set(input.groupIds ?? [])];
    if (studentIds.length + groupIds.length === 0)
      throw AppError.validation('At least one addressee is required');
    const now = this.clock.now();
    return this.txm.run(async () => {
      for (const id of studentIds) await this.assertStudent(actor, id);
      for (const id of groupIds) await this.assertGroup(actor, id);
      for (const lessonId of [input.assignedLessonId, input.checkLessonId]) {
        if (!lessonId) continue;
        const lesson = await this.lessons.findById(lessonId);
        if (!lesson || lesson.teacherId !== actor.accountId) throw AppError.notFound('lesson', lessonId);
      }
      if (input.collectionId) {
        const col = await this.materials.findCollection(input.collectionId);
        if (!col || col.teacherId !== actor.accountId || col.archivedAt)
          throw AppError.notFound('collection', input.collectionId);
      }
      const row = await this.repo.insert({
        teacherId: actor.accountId,
        title,
        body,
        dueMode: input.dueMode,
        dueAt: input.dueMode === 'fixed' ? input.dueAt! : null,
        assignedLessonId: input.assignedLessonId ?? null,
        checkLessonId: input.checkLessonId ?? null,
        collectionId: input.collectionId ?? null,
        submissionMode: input.submissionMode,
        submissionRules: rules,
        grading,
        status: 'draft',
      });
      for (const groupId of groupIds) await this.repo.addGroup(row.id, groupId);
      // draft targets remember the direct addressees; publishing adds the group members of that moment
      for (const studentId of studentIds)
        await this.repo.insertTarget({ assignmentId: row.id, studentId, status: 'assigned', createdAt: now });
      await this.record(actor, 'assignment.created', row.id, {
        dueMode: row.dueMode,
        students: studentIds.length,
        groups: groupIds.length,
      });
      return options.draft ? row : this.publishLocked(actor, row);
    });
  }

  async publish(actor: Actor, assignmentId: string): Promise<AssignmentRow> {
    assertRole(actor, 'TEACHER');
    return this.txm.run(async () => this.publishLocked(actor, await this.own(actor, assignmentId, true)));
  }

  /** Expands the addressees into targets with their due dates and announces `homework.published`. */
  private async publishLocked(actor: Actor, row: AssignmentRow): Promise<AssignmentRow> {
    if (row.status !== 'draft')
      throw new AppError('CONFLICT', 'The assignment is already published', { status: row.status });
    await this.features.assertEnabled(actor.accountId, 'homework');
    const now = this.clock.now();
    if (row.dueMode === 'fixed' && row.dueAt && row.dueAt.getTime() <= now.getTime())
      throw AppError.validation('dueAt must be in the future', { reason: 'due_in_past' });
    const members = new Set<string>();
    for (const groupId of await this.repo.listGroupIds(row.id))
      for (const m of await this.groups.listMembers(groupId)) members.add(m.studentId);
    for (const studentId of members)
      await this.repo.insertTarget({ assignmentId: row.id, studentId, status: 'assigned', createdAt: now });
    const targets: AssignmentTargetRow[] = [];
    for (const t of await this.repo.listTargets(row.id)) {
      // only current students of the teacher become targets (8.0); a link ended since the draft drops the row
      const link = await this.links.findByPair(row.teacherId, t.studentId);
      if (link?.status !== 'active') {
        await this.repo.deleteTarget(t.id);
        continue;
      }
      const due = await this.dueOf(row, t.studentId, now);
      targets.push(await this.repo.updateTarget(t.id, due));
    }
    const updated = await this.repo.update(row.id, { status: 'published', publishedAt: now });
    await this.record(actor, 'assignment.published', row.id, { targets: targets.length });
    await this.outbox.publish({
      type: 'homework.published',
      aggregateType: 'assignment',
      aggregateId: row.id,
      payload: {
        assignmentId: row.id,
        teacherId: row.teacherId,
        targets: targets.map((t) => ({
          targetId: t.id,
          studentId: t.studentId,
          dueAt: t.dueAt?.toISOString() ?? null,
        })),
      },
    });
    return updated;
  }

  /** Closing withdraws what was never handed in (5.10.2 `withdrawn`); submitted work stays reviewable. */
  async close(actor: Actor, assignmentId: string): Promise<AssignmentRow> {
    assertRole(actor, 'TEACHER');
    return this.txm.run(async () => {
      const row = await this.own(actor, assignmentId, true);
      if (row.status === 'closed') return row;
      const now = this.clock.now();
      for (const t of await this.repo.listTargets(row.id)) await this.withdraw(t, 'closed');
      const updated = await this.repo.update(row.id, { status: 'closed', closedAt: now });
      await this.record(actor, 'assignment.closed', row.id, { from: row.status });
      return updated;
    });
  }

  /** A student who joins a group of a published assignment becomes a target (5.9.3 «новые участники»). */
  async addTarget(assignment: AssignmentRow, studentId: string): Promise<AssignmentTargetRow | null> {
    return this.txm.run(async () => {
      const link = await this.links.findByPair(assignment.teacherId, studentId);
      if (link?.status !== 'active' || assignment.status !== 'published') return null;
      const due = await this.dueOf(assignment, studentId, this.baseOf(assignment, this.clock.now()));
      const target = await this.repo.insertTarget({
        assignmentId: assignment.id,
        studentId,
        status: 'assigned',
        createdAt: this.clock.now(),
        ...due,
      });
      if (!target) return null;
      await this.outbox.publish({
        type: 'homework.target_added',
        aggregateType: 'assignment',
        aggregateId: assignment.id,
        payload: {
          assignmentId: assignment.id,
          teacherId: assignment.teacherId,
          targetId: target.id,
          studentId,
          dueAt: target.dueAt?.toISOString() ?? null,
        },
      });
      return target;
    });
  }

  /**
   * Recomputes the due date of a next-lesson target (after a move, a cancellation or a new lesson). The row is
   * locked and re-read: a target that was handed in or finished meanwhile is left alone. A deadline that
   * already passed with its lesson held stays in the past (the next lesson is not a second chance).
   */
  async recomputeDue(stale: AssignmentTargetRow): Promise<AssignmentTargetRow> {
    return this.txm.run(async () => {
      const target = await this.repo.findTarget(stale.id, { forUpdate: true });
      if (!target || !RECOMPUTABLE.includes(target.status)) return stale;
      const assignment = await this.repo.findById(target.assignmentId);
      if (!assignment || assignment.dueMode !== 'next_lesson' || assignment.status !== 'published')
        return target;
      const now = this.clock.now();
      if (target.dueLessonId && target.dueAt && target.dueAt.getTime() <= now.getTime()) {
        const held = await this.lessons.findById(target.dueLessonId);
        if (held && held.status !== 'cancelled' && held.status !== 'scheduled') return target;
      }
      const due = await this.dueOf(assignment, target.studentId, this.baseOf(assignment, now));
      if (due.dueAt?.getTime() === target.dueAt?.getTime() && due.dueLessonId === target.dueLessonId)
        return target;
      // a later deadline revives an overdue target (5.10.2: overdue only means «срок прошёл»)
      const revived = target.status === 'overdue' && (!due.dueAt || due.dueAt.getTime() > now.getTime());
      const updated = await this.repo.transitionTarget(target.id, RECOMPUTABLE, {
        ...due,
        status: revived ? 'assigned' : target.status,
        overdueNotifiedAt: revived ? null : target.overdueNotifiedAt,
      });
      if (!updated) return target;
      await this.outbox.publish({
        type: 'homework.due_changed',
        aggregateType: 'assignment',
        aggregateId: assignment.id,
        payload: {
          assignmentId: assignment.id,
          teacherId: assignment.teacherId,
          targetId: updated.id,
          studentId: updated.studentId,
          dueAt: updated.dueAt?.toISOString() ?? null,
        },
      });
      return updated;
    });
  }

  /**
   * 5.10.2 `withdrawn`: the assignment closed or the link ended. Guarded: work handed in or finished in the
   * meantime is kept (it stays reviewable); reminders are dropped by the handler.
   */
  async withdraw(
    target: AssignmentTargetRow,
    reason: 'closed' | 'link_ended' | 'account_blocked',
    options: { includeSubmitted?: boolean } = {},
  ): Promise<boolean> {
    return this.txm.run(async () => {
      const from = options.includeSubmitted ? [...RECOMPUTABLE, 'submitted' as const] : RECOMPUTABLE;
      const updated = await this.repo.transitionTarget(target.id, from, { status: 'withdrawn' });
      if (!updated) return false;
      await this.outbox.publish({
        type: 'homework.withdrawn',
        aggregateType: 'assignment',
        aggregateId: target.assignmentId,
        payload: {
          assignmentId: target.assignmentId,
          targetId: target.id,
          studentId: target.studentId,
          reason,
        },
      });
      return true;
    });
  }

  /** The «next lesson» is searched from publication, but never from the past: a lesson gone by is no deadline. */
  private baseOf(assignment: AssignmentRow, now: Date): Date {
    const published = assignment.publishedAt ?? now;
    return published.getTime() > now.getTime() ? published : now;
  }

  /** 5.10.1 «к следующему занятию»: the student's next scheduled lesson with the teacher after `from`. */
  async dueOf(assignment: AssignmentRow, studentId: string, from: Date): Promise<DueResult> {
    if (assignment.dueMode !== 'next_lesson') return dueFor(assignment.dueMode, assignment.dueAt, null);
    const horizon = { start: from, end: new Date(from.getTime() + NEXT_LESSON_HORIZON_DAYS * DAY_MS) };
    const next = (await this.lessons.listByStudent(studentId, horizon, ['scheduled'])).find(
      (l) => l.teacherId === assignment.teacherId && l.startsAt.getTime() > from.getTime(),
    );
    return dueFor('next_lesson', null, next ? { id: next.id, startsAt: next.startsAt } : null);
  }

  async own(actor: Actor, assignmentId: string, forUpdate = false): Promise<AssignmentRow> {
    const row = await this.repo.findById(assignmentId, { forUpdate });
    if (!row || row.teacherId !== actor.accountId) throw AppError.notFound('assignment', assignmentId);
    return row;
  }

  private async assertStudent(actor: Actor, studentId: string): Promise<void> {
    const link = await this.links.findByPair(actor.accountId, studentId);
    if (link?.status !== 'active')
      throw new AppError('LINK_NOT_ACTIVE', 'The student is not yours', { reason: 'not_linked', studentId });
  }

  private async assertGroup(actor: Actor, groupId: string): Promise<void> {
    const group = await this.groups.findById(groupId);
    if (!group || group.teacherId !== actor.accountId || group.archivedAt)
      throw AppError.notFound('group', groupId);
  }

  private async record(
    actor: Actor,
    action: string,
    entityId: string,
    after: Record<string, unknown> | null,
  ) {
    await this.audit.record({
      actorId: actor.accountId,
      actorRole: 'TEACHER',
      action,
      entityType: 'assignment',
      entityId,
      after,
      source: actor.source,
      ip: actor.ip,
    });
  }
}
