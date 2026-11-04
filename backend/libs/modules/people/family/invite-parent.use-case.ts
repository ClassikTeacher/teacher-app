import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { type Actor, assertRole, primaryRole } from '@modules/access/actor.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { InvitationRepository } from '@modules/identity/invitation.repository.js';
import { InvitationService, type IssuedInvitation } from '@modules/identity/invitation.service.js';
import type { InvitationRow } from '@modules/identity/schema.js';
import { assertLinkActive, MAX_PARENTS_PER_STUDENT } from '../links/link.rules.js';
import { TeacherStudentRepository } from '../links/teacher-student.repository.js';
import { FamilyLinkRepository } from './family-link.repository.js';

/**
 * UC-11 steps 1–2: only a teacher with an active link invites a parent, from the student's card (Р-4, 5.4.3).
 * Active parents plus outstanding parent links are capped at four, so a flood of links cannot overshoot the limit.
 */
@Injectable()
export class InviteParentUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly invitations: InvitationService,
    private readonly invitationRows: InvitationRepository,
    private readonly accounts: AccountRepository,
    private readonly links: TeacherStudentRepository,
    private readonly family: FamilyLinkRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async execute(actor: Actor, linkId: string): Promise<IssuedInvitation> {
    assertRole(actor, 'TEACHER');
    const now = this.clock.now();
    return this.txm.run(async () => {
      const link = await this.links.findById(linkId);
      if (!link || link.teacherId !== actor.accountId || !link.studentId) {
        throw AppError.notFound('student card', linkId);
      }
      assertLinkActive(link);
      const studentId = link.studentId;
      // the student row is the lock for seat accounting, shared with acceptance (AcceptParentInvitationUseCase)
      const student = await this.accounts.findById(studentId, { forUpdate: true });
      if (!student || student.status === 'blocked') {
        throw new AppError('ACCOUNT_BLOCKED', 'Student account is blocked', { studentId });
      }
      const [active, pending] = await Promise.all([
        this.family.listActiveByStudent(studentId),
        this.invitationRows.listPendingParentInvites(studentId, now),
      ]);
      if (active.length + pending.length >= MAX_PARENTS_PER_STUDENT) {
        throw new AppError('LIMIT_EXCEEDED', 'A student can have at most four parents', {
          limit: 'maxParents',
          max: MAX_PARENTS_PER_STUDENT,
        });
      }
      const issued = await this.invitations.create(
        { kind: 'parent', createdBy: actor.accountId, payload: { teacherId: actor.accountId, studentId } },
        now,
      );
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: primaryRole(actor),
        action: 'parent.invited',
        entityType: 'invitation',
        entityId: issued.invitation.id,
        after: { studentId, linkId: link.id },
        source: actor.source,
        ip: actor.ip,
      });
      return issued;
    });
  }

  /** Outstanding parent links of the student issued by this teacher (the screen shows and revokes only its own). */
  async pendingFor(teacherId: string, studentId: string, now: Date): Promise<InvitationRow[]> {
    const all = await this.invitationRows.listPendingParentInvites(studentId, now);
    return all.filter((inv) => inv.createdBy === teacherId);
  }

  async revoke(actor: Actor, invitationId: string): Promise<InvitationRow> {
    assertRole(actor, 'TEACHER');
    const now = this.clock.now();
    return this.txm.run(async () => {
      const existing = await this.invitationRows.findById(invitationId);
      if (!existing || existing.kind !== 'parent' || existing.createdBy !== actor.accountId) {
        throw AppError.notFound('invitation', invitationId);
      }
      const row = await this.invitations.revoke(invitationId, actor.accountId, now);
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: primaryRole(actor),
        action: 'invitation.revoked',
        entityType: 'invitation',
        entityId: row.id,
        before: { status: existing.status },
        after: { status: row.status },
        source: actor.source,
        ip: actor.ip,
      });
      return row;
    });
  }
}
