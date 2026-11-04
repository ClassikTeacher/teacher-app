import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { type Actor, assertActive } from '@modules/access/actor.js';
import type { Role } from '@modules/identity/schema.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { FamilyLinkRepository } from '../family/family-link.repository.js';
import { GroupRepository } from '../groups/group.repository.js';
import type { EndReason, TeacherStudentRow } from '../schema.js';
import { LeaveRequestRepository } from './leave-request.repository.js';
import { assertLinkActive, MAX_END_MESSAGE_LENGTH } from './link.rules.js';
import { TeacherStudentRepository } from './teacher-student.repository.js';

export interface EndLinkInput {
  reason: EndReason;
  /** Mandatory for the teacher (5.8.1) and the student (LINK-01); the parent's message (5.8.3). */
  message: string;
  /** `left_by_student` on behalf of a parent is allowed only through the request they just approved (LINK-02). */
  approvedRequestId?: string;
}

/** What ending a link would do right now (5.8.4), for the confirmation screen (UC-33 step 3). */
export interface EndConsequences {
  groups: number;
  /** Lessons and assignments are counted by scheduling/homework from M3/M5 on; null until then. */
  lessons: number | null;
  assignments: number | null;
  activeParents: number;
}

/**
 * 5.8 / 5.8.4: ends an active teacher–student link — by the teacher (`removed_by_teacher`), the student
 * (`left_by_student`, directly when no parent is linked or after a parent's consent), a parent
 * (`ended_by_parent`) or the system. Closes the period and the teacher's group memberships here; lessons,
 * requests, homework and material access react to `link.ended` in their own modules (M4-06, M5).
 */
@Injectable()
export class EndLinkUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly links: TeacherStudentRepository,
    private readonly groups: GroupRepository,
    private readonly family: FamilyLinkRepository,
    private readonly leaves: LeaveRequestRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  async consequences(link: TeacherStudentRow): Promise<EndConsequences> {
    if (!link.studentId) return { groups: 0, lessons: null, assignments: null, activeParents: 0 };
    const [memberships, parents] = await Promise.all([
      this.groups.listActiveMembershipsOfStudent(link.studentId),
      this.family.listActiveByStudent(link.studentId),
    ]);
    const teacherGroups = new Set(
      (await this.groups.listByTeacher(link.teacherId, { archived: false })).map((g) => g.id),
    );
    return {
      groups: memberships.filter((m) => teacherGroups.has(m.groupId)).length,
      lessons: null,
      assignments: null,
      activeParents: parents.length,
    };
  }

  /** The actor must be a party to the link in the role matching `reason` (checked by the callers' rules). */
  async execute(actor: Actor, linkId: string, input: EndLinkInput): Promise<TeacherStudentRow> {
    assertActive(actor);
    const message = input.message.trim();
    if (!message) throw new AppError('CANCEL_REASON_REQUIRED', 'A message is required to end the link');
    if (message.length > MAX_END_MESSAGE_LENGTH)
      throw AppError.validation('Message is too long', { max: MAX_END_MESSAGE_LENGTH });
    const now = this.clock.now();
    return this.txm.run(async () => {
      const link = await this.links.findById(linkId, { forUpdate: true });
      if (!link || !link.studentId) throw AppError.notFound('student card', linkId);
      const actorRole = await this.assertParty(actor, link, input); // the role acted in, for the audit (M-4)
      assertLinkActive(link);
      const studentId = link.studentId;
      const byAccountId = actor.source === 'system' ? null : actor.accountId; // the system actor is not an account row

      const ended = await this.links.update(link.id, {
        status: 'ended',
        endedAt: now,
        endedBy: byAccountId,
        endReason: input.reason,
        endMessage: message,
      });
      await this.links.closePeriod(link.id, now, input.reason);
      const leftGroups = await this.groups.removeStudentFromTeacherGroups(link.teacherId, studentId, now);
      // lock order everywhere: link first, then the request (LeaveRequestUseCase.decide follows the same order)
      const pendingLeave = await this.leaves.findPendingByLink(link.id);
      if (pendingLeave) {
        await this.leaves.decide(pendingLeave.id, 'cancelled', {
          decidedBy: byAccountId,
          decisionComment: null,
          decidedAt: now,
        });
        await this.audit.record({
          actorId: byAccountId,
          actorRole,
          action: 'leave_request.cancelled',
          entityType: 'leave_request',
          entityId: pendingLeave.id,
          after: { linkId: link.id, reason: input.reason },
          source: actor.source,
        });
      }
      await this.audit.record({
        actorId: byAccountId,
        actorRole,
        action: 'link.ended',
        entityType: 'teacher_student',
        entityId: link.id,
        before: { status: 'active' },
        after: {
          status: 'ended',
          reason: input.reason,
          groupsLeft: leftGroups.length,
          messageLength: message.length,
        },
        source: actor.source,
        ip: actor.ip,
      });
      await this.outbox.publish({
        type: 'link.ended',
        aggregateType: 'teacher_student',
        aggregateId: link.id,
        payload: {
          linkId: link.id,
          teacherId: link.teacherId,
          studentId,
          reason: input.reason,
          byAccountId,
          cancelledRequestId: pendingLeave?.id ?? null,
          message,
          groupIds: leftGroups,
          at: now.toISOString(),
        },
      });
      return ended;
    });
  }

  /**
   * Who may end with which reason (3.7, LINK-01/02): the teacher — `removed_by_teacher`; the student alone —
   * `left_by_student` only while no parent is linked; a parent — `left_by_student` only through the request they
   * approved, or `ended_by_parent` directly; the system — `system`.
   */
  private async assertParty(
    actor: Actor,
    link: TeacherStudentRow,
    input: EndLinkInput,
  ): Promise<Role | null> {
    const studentId = link.studentId!;
    const isParent = async (): Promise<boolean> =>
      actor.roles.includes('PARENT') && (await this.family.findActive(actor.accountId, studentId)) !== null;
    let ok = false;
    switch (input.reason) {
      case 'removed_by_teacher':
        ok = actor.accountId === link.teacherId && actor.roles.includes('TEACHER');
        break;
      case 'left_by_student':
        if (actor.accountId === studentId) {
          ok = (await this.family.listActiveByStudent(studentId)).length === 0;
        } else if (input.approvedRequestId && (await isParent())) {
          const request = await this.leaves.findById(input.approvedRequestId);
          ok =
            request?.teacherStudentId === link.id &&
            request.status === 'approved' &&
            request.decidedBy === actor.accountId;
        }
        break;
      case 'ended_by_parent':
        ok = await isParent();
        break;
      case 'system':
        ok = actor.source === 'system';
        break;
    }
    if (!ok)
      throw AppError.forbidden('You are not allowed to end this link with this reason', {
        reason: input.reason,
      });
    const byRole: Record<EndLinkInput['reason'], Role | null> = {
      removed_by_teacher: 'TEACHER',
      left_by_student: actor.accountId === studentId ? 'STUDENT' : 'PARENT',
      ended_by_parent: 'PARENT',
      system: null,
    };
    return byRole[input.reason];
  }
}
