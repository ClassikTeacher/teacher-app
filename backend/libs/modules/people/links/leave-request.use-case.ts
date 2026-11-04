import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { addHours, Clock } from '@shared/time/clock.js';
import { type Actor, assertActive } from '@modules/access/actor.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { FamilyLinkRepository } from '../family/family-link.repository.js';
import type { LeaveRequestRow, TeacherStudentRow } from '../schema.js';
import { EndLinkUseCase } from './end-link.use-case.js';
import { LeaveRequestRepository } from './leave-request.repository.js';
import { assertLinkActive, LEAVE_REQUEST_TTL_HOURS, MAX_END_MESSAGE_LENGTH } from './link.rules.js';
import { TeacherStudentRepository } from './teacher-student.repository.js';

export type LeaveOutcome =
  { kind: 'ended'; link: TeacherStudentRow } | { kind: 'requested'; request: LeaveRequestRow };

/**
 * 5.8.2 / UC-34, UC-35: a student asks to leave a teacher. Without an active parent the link ends at once
 * (LINK-01); otherwise a request goes to the parents, any one of whom decides (LINK-02, LINK-03); it expires
 * after 7 days (UC-40). The teacher learns only the outcome (LINK-05).
 */
@Injectable()
export class LeaveRequestUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly links: TeacherStudentRepository,
    private readonly family: FamilyLinkRepository,
    private readonly requests: LeaveRequestRepository,
    private readonly endLink: EndLinkUseCase,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  /** Whether the student's request will need a parent's consent (for the bot to pick the right dialog). */
  async needsConsent(studentId: string): Promise<boolean> {
    return (await this.family.listActiveByStudent(studentId)).length > 0;
  }

  async request(actor: Actor, linkId: string, reason: string): Promise<LeaveOutcome> {
    assertActive(actor);
    const text = reason.trim();
    if (!text) throw new AppError('CANCEL_REASON_REQUIRED', 'A reason is required');
    if (text.length > MAX_END_MESSAGE_LENGTH)
      throw AppError.validation('Reason is too long', { max: MAX_END_MESSAGE_LENGTH });
    const now = this.clock.now();
    return this.txm.run(async () => {
      const link = await this.links.findById(linkId, { forUpdate: true });
      if (!link || link.studentId !== actor.accountId) throw AppError.notFound('teacher', linkId);
      assertLinkActive(link);
      const parents = await this.family.listActiveByStudent(actor.accountId);
      if (parents.length === 0) {
        const ended = await this.endLink.execute(actor, link.id, {
          reason: 'left_by_student',
          message: text,
        });
        return { kind: 'ended', link: ended };
      }
      if (await this.requests.findPendingByLink(link.id)) {
        throw new AppError('CONFLICT', 'A leave request is already waiting for a parent', {
          reason: 'pending_request',
        });
      }
      const request = await this.requests.insert({
        teacherStudentId: link.id,
        initiatedBy: actor.accountId,
        reason: text,
        expiresAt: addHours(now, LEAVE_REQUEST_TTL_HOURS),
      });
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: 'STUDENT', // the request is the student's act (M-4)
        action: 'leave_request.created',
        entityType: 'leave_request',
        entityId: request.id,
        after: { linkId: link.id, expiresAt: request.expiresAt.toISOString() },
        source: actor.source,
      });
      await this.outbox.publish({
        type: 'link.leave_requested',
        aggregateType: 'leave_request',
        aggregateId: request.id,
        payload: {
          requestId: request.id,
          linkId: link.id,
          teacherId: link.teacherId,
          studentId: actor.accountId,
          parentIds: parents.map((p) => p.parentId),
          reason: text,
          expiresAt: request.expiresAt.toISOString(),
        },
      });
      return { kind: 'requested', request };
    });
  }

  /** LINK-03: the first parent's answer closes the request; a second answer gets CONFLICT. */
  async decide(
    actor: Actor,
    requestId: string,
    approve: boolean,
    comment: string | null,
  ): Promise<LeaveRequestRow> {
    assertActive(actor);
    const note = comment?.trim() || null;
    if (note && note.length > MAX_END_MESSAGE_LENGTH) throw AppError.validation('Comment is too long');
    const now = this.clock.now();
    return this.txm.run(async () => {
      // lock order: link first, then the request — the same order EndLinkUseCase uses (no deadlock)
      const unlocked = await this.requests.findById(requestId);
      if (!unlocked) throw AppError.notFound('leave request', requestId);
      const link = await this.links.findById(unlocked.teacherStudentId, { forUpdate: true });
      if (!link?.studentId || !(await this.family.findActive(actor.accountId, link.studentId))) {
        throw AppError.forbidden('Only an active parent of the student may decide');
      }
      const request = (await this.requests.findById(requestId, { forUpdate: true }))!;
      const decided = await this.requests.decide(request.id, approve ? 'approved' : 'declined', {
        decidedBy: actor.accountId,
        decisionComment: note,
        decidedAt: now,
      });
      if (!decided)
        throw new AppError('CONFLICT', 'The request was already decided', { status: request.status });
      if (approve && link.status === 'active') {
        await this.endLink.execute(actor, link.id, {
          reason: 'left_by_student',
          message: request.reason,
          approvedRequestId: request.id,
        });
      }
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: 'PARENT', // decided as the parent (M-4)
        action: approve ? 'leave_request.approved' : 'leave_request.declined',
        entityType: 'leave_request',
        entityId: request.id,
        after: { linkId: link.id, commentLength: note?.length ?? 0 },
        source: actor.source,
      });
      await this.outbox.publish({
        type: 'link.leave_decided',
        aggregateType: 'leave_request',
        aggregateId: request.id,
        payload: {
          requestId: request.id,
          linkId: link.id,
          teacherId: link.teacherId,
          studentId: link.studentId,
          decidedBy: actor.accountId,
          approved: approve,
          comment: note,
        },
      });
      return decided;
    });
  }

  /** UC-40: pending requests past their deadline expire; the student is told (5.8.2 "нет ответа 7 дней"). */
  async expireOverdue(): Promise<number> {
    const now = this.clock.now();
    return this.txm.run(async () => {
      const overdue = await this.requests.lockOverdue(now);
      for (const r of overdue) {
        const expired = await this.requests.decide(r.id, 'expired', {
          decidedBy: null,
          decisionComment: null,
          decidedAt: now,
        });
        if (!expired) continue;
        const link = await this.links.findById(r.teacherStudentId);
        await this.audit.record({
          actorId: null,
          actorRole: null,
          action: 'leave_request.expired',
          entityType: 'leave_request',
          entityId: r.id,
          after: { linkId: r.teacherStudentId },
          source: 'system',
        });
        await this.outbox.publish({
          type: 'link.leave_expired',
          aggregateType: 'leave_request',
          aggregateId: r.id,
          payload: {
            requestId: r.id,
            linkId: r.teacherStudentId,
            studentId: r.initiatedBy,
            teacherId: link?.teacherId ?? null,
          },
        });
      }
      return overdue.length;
    });
  }
}
