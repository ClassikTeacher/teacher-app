import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { type Actor, assertRole, primaryRole } from '@modules/access/actor.js';
import { FeatureService } from '@modules/access/features/feature.service.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { InvitationRepository } from '@modules/identity/invitation.repository.js';
import { InvitationService, type IssuedInvitation } from '@modules/identity/invitation.service.js';
import type { TeacherStudentRow } from '../schema.js';
import { SubjectRepository } from '../subject.repository.js';
import { assertStudentLimit, MAX_GRADE_LENGTH, normalizeWeeklyLimit } from './link.rules.js';
import { TeacherStudentRepository } from './teacher-student.repository.js';

export interface InviteStudentInput {
  subjectIds: string[];
  /** PPL-06: null = no limit. */
  maxLessonsPerWeek: number | null;
  displayName?: string | null;
  grade?: string | null;
}

export interface IssuedStudentInvitation {
  link: TeacherStudentRow;
  issued: IssuedInvitation;
}

const MAX_DISPLAY_NAME = 100;
/** Cards that occupy a seat under `max_students` (PPL-05). */
const COUNTED_STATUSES = ['active', 'pending'] as const;

/**
 * UC-10 steps 2–3: a teacher creates a pending card and gets a personal StudentBot link (PPL-01, PPL-05,
 * PPL-06). The same use-case revokes a pending card or re-issues an expired/declined one.
 */
@Injectable()
export class InviteStudentUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly invitations: InvitationService,
    private readonly invitationRows: InvitationRepository,
    private readonly links: TeacherStudentRepository,
    private readonly subjects: SubjectRepository,
    private readonly features: FeatureService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async execute(actor: Actor, input: InviteStudentInput): Promise<IssuedStudentInvitation> {
    assertRole(actor, 'TEACHER');
    const subjectIds = await this.validateSubjects(input.subjectIds);
    const maxLessonsPerWeek = normalizeWeeklyLimit(input.maxLessonsPerWeek);
    const displayName = this.cleanText(input.displayName, MAX_DISPLAY_NAME, 'displayName');
    const grade = this.cleanText(input.grade, MAX_GRADE_LENGTH, 'grade');
    const now = this.clock.now();
    return this.txm.run(async () => {
      await this.links.lockTeacherSeats(actor.accountId);
      await this.assertSeatAvailable(actor.accountId);
      const issued = await this.issue(
        actor.accountId,
        { subjectIds, maxLessonsPerWeek, displayName, grade },
        now,
      );
      const link = await this.links.insertPending({
        teacherId: actor.accountId,
        invitationId: issued.invitation.id,
        inviteName: displayName,
        inviteGrade: grade,
        subjectIds,
        maxLessonsPerWeek,
      });
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: primaryRole(actor),
        action: 'student.invited',
        entityType: 'teacher_student',
        entityId: link.id,
        after: { invitationId: issued.invitation.id, subjectIds, maxLessonsPerWeek },
        source: actor.source,
        ip: actor.ip,
      });
      return { link, issued };
    });
  }

  /** UC-10 3а up front: tells the teacher about a full roster before the dialog starts (no lock, advisory only). */
  async assertCanInvite(actor: Actor): Promise<void> {
    assertRole(actor, 'TEACHER');
    await this.assertSeatAvailable(actor.accountId);
  }

  /** PPL-05 under the seat lock when called from a writing use-case. */
  private async assertSeatAvailable(teacherId: string): Promise<void> {
    const limit = await this.features.limit(teacherId, 'core', 'maxStudents');
    assertStudentLimit(await this.links.countByTeacher(teacherId, COUNTED_STATUSES), limit);
  }

  /** Withdraws a pending (or declined) card: the link stops working and the seat is freed. */
  async revokePending(actor: Actor, linkId: string): Promise<TeacherStudentRow> {
    assertRole(actor, 'TEACHER');
    const now = this.clock.now();
    return this.txm.run(async () => {
      const link = await this.ownCard(actor, linkId, ['pending', 'declined']);
      await this.revokeInvitationOf(link, actor.accountId, now);
      const updated = await this.links.update(link.id, { status: 'cancelled' });
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: primaryRole(actor),
        action: 'student.invitation_revoked',
        entityType: 'teacher_student',
        entityId: link.id,
        before: { status: link.status },
        after: { status: 'cancelled' },
        source: actor.source,
        ip: actor.ip,
      });
      return updated;
    });
  }

  /**
   * New link for a card whose invitation expired or was declined (UC-11 3б applies to students too).
   * Cancelled cards are final: a withdrawn card, or one absorbed by a reopened link, never comes back.
   */
  async reissue(actor: Actor, linkId: string): Promise<IssuedStudentInvitation> {
    assertRole(actor, 'TEACHER');
    const now = this.clock.now();
    return this.txm.run(async () => {
      await this.links.lockTeacherSeats(actor.accountId);
      const link = await this.ownCard(actor, linkId, ['pending', 'declined']);
      if (link.status !== 'pending') await this.assertSeatAvailable(actor.accountId);
      await this.revokeInvitationOf(link, actor.accountId, now);
      const issued = await this.issue(
        actor.accountId,
        {
          subjectIds: link.subjectIds,
          maxLessonsPerWeek: link.maxLessonsPerWeek,
          displayName: link.inviteName,
          grade: link.inviteGrade,
        },
        now,
      );
      const updated = await this.links.update(link.id, {
        status: 'pending',
        invitationId: issued.invitation.id,
      });
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: primaryRole(actor),
        action: 'student.invitation_reissued',
        entityType: 'teacher_student',
        entityId: link.id,
        before: { status: link.status, invitationId: link.invitationId },
        after: { status: 'pending', invitationId: issued.invitation.id },
        source: actor.source,
        ip: actor.ip,
      });
      return { link: updated, issued };
    });
  }

  private issue(
    teacherId: string,
    card: {
      subjectIds: string[];
      maxLessonsPerWeek: number | null;
      displayName: string | null;
      grade: string | null;
    },
    now: Date,
  ): Promise<IssuedInvitation> {
    return this.invitations.create(
      {
        kind: 'student',
        createdBy: teacherId,
        payload: {
          teacherId,
          subjectId: card.subjectIds[0],
          maxLessonsPerWeek: card.maxLessonsPerWeek,
          displayName: card.displayName ?? undefined,
          grade: card.grade ?? undefined,
        },
      },
      now,
    );
  }

  private async revokeInvitationOf(link: TeacherStudentRow, by: string, now: Date): Promise<void> {
    if (!link.invitationId) return;
    const inv = await this.invitationRows.findById(link.invitationId); // already locked by ownCard
    if (inv?.status === 'pending') await this.invitations.revoke(inv.id, by, now);
  }

  /**
   * Loads the teacher's own card for writing. Lock order matches acceptance (invitation row first, then the
   * card), so a student pressing "Принять" while the teacher withdraws the link cannot deadlock.
   */
  private async ownCard(
    actor: Actor,
    linkId: string,
    allowed: readonly TeacherStudentRow['status'][],
  ): Promise<TeacherStudentRow> {
    const unlocked = await this.links.findById(linkId);
    if (!unlocked || unlocked.teacherId !== actor.accountId) throw AppError.notFound('student card', linkId);
    if (unlocked.invitationId) await this.invitationRows.findById(unlocked.invitationId, { forUpdate: true });
    const link = await this.links.findById(linkId, { forUpdate: true });
    if (!link || link.teacherId !== actor.accountId) throw AppError.notFound('student card', linkId);
    if (!allowed.includes(link.status)) {
      throw new AppError('CONFLICT', 'Card is in the wrong state for this action', { status: link.status });
    }
    return link;
  }

  private async validateSubjects(ids: string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) throw AppError.validation('At least one subject is required');
    const found = await this.subjects.findByIds(unique);
    if (found.length !== unique.length || found.some((s) => !s.isActive)) {
      throw AppError.validation('Unknown or inactive subject');
    }
    return unique;
  }

  private cleanText(value: string | null | undefined, max: number, field: string): string | null {
    const trimmed = value?.trim() ?? '';
    if (!trimmed) return null;
    if (trimmed.length > max) throw AppError.validation(`${field} is too long`, { max });
    return trimmed;
  }
}
