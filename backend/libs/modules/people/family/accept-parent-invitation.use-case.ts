import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { InvitationService, type PeekedInvitation } from '@modules/identity/invitation.service.js';
import type { TelegramIdentity } from '@modules/identity/redeem-staff-invitation.use-case.js';
import type { AccountRow } from '@modules/identity/schema.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { assertParentLimit, MAX_PARENTS_PER_STUDENT } from '../links/link.rules.js';
import { TeacherStudentRepository } from '../links/teacher-student.repository.js';
import { type PersonQuestionnaire, PersonOnboardingService } from '../person-onboarding.service.js';
import type { FamilyLinkRow } from '../schema.js';
import { FamilyLinkRepository } from './family-link.repository.js';

export interface ParentInvitationPreview {
  invitation: PeekedInvitation;
  student: AccountRow;
  teacher: AccountRow;
  /** UC-11 3в: the student opened their own parent link. */
  isStudentSelf: boolean;
  /** 5.4.3: the student already has four parents. */
  limitReached: boolean;
  /** The inviting teacher no longer has an active link with the student (8.0). */
  teacherLinkActive: boolean;
}

export interface AcceptParentInput {
  user: TelegramIdentity;
  token: string;
  chatId: number;
  /** Required unless the account is already active (UC-11 3а: no second onboarding). */
  questionnaire?: PersonQuestionnaire;
  /** Version of the document accepted on behalf of the child (always required, 10.2). */
  consentVersion: string;
}

export interface AcceptParentResult {
  account: AccountRow;
  familyLink: FamilyLinkRow;
  student: AccountRow;
  teacher: AccountRow;
}

/**
 * UC-11 steps 3–4: a parent opens the ParentBot link issued by a teacher from the student's card, confirms
 * being the legal representative, answers the questionnaire (new accounts) and consents on behalf of the child.
 * The family link is shared by all teachers of the student (Р-4) and limited to four parents (5.4.3).
 */
@Injectable()
export class AcceptParentInvitationUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly invitations: InvitationService,
    private readonly accounts: AccountRepository,
    private readonly family: FamilyLinkRepository,
    private readonly links: TeacherStudentRepository,
    private readonly onboarding: PersonOnboardingService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  async peek(token: string, telegramUserId: number): Promise<ParentInvitationPreview | null> {
    const peeked = await this.invitations.peek(token, telegramUserId, this.clock.now());
    if (!peeked || peeked.kind !== 'parent' || !peeked.createdBy || !peeked.payload.studentId) return null;
    const [student, teacher] = await Promise.all([
      this.accounts.findById(peeked.payload.studentId),
      this.accounts.findById(peeked.createdBy),
    ]);
    if (!student || !teacher) return null;
    const [parents, link] = await Promise.all([
      this.family.listActiveByStudent(student.id),
      this.links.findByPair(teacher.id, student.id),
    ]);
    return {
      invitation: peeked,
      student,
      teacher,
      isStudentSelf: student.telegramUserId === telegramUserId,
      limitReached: parents.length >= MAX_PARENTS_PER_STUDENT,
      teacherLinkActive: link?.status === 'active',
    };
  }

  private async assertTeacherAuthorized(teacherId: string): Promise<AccountRow> {
    const teacher = await this.accounts.findById(teacherId);
    const roles = teacher ? await this.accounts.activeRoles(teacher.id) : [];
    if (!teacher || teacher.status !== 'active' || !roles.includes('TEACHER')) {
      throw new AppError('INVITATION_INVALID', 'Invitation is not valid', { reason: 'inviter_unauthorized' });
    }
    return teacher;
  }

  async accept(input: AcceptParentInput): Promise<AcceptParentResult> {
    const now = this.clock.now();
    return this.txm.run(async () => {
      const { account: initial } = await this.onboarding.ensureAccount(input.user);
      let account = initial;
      const inv = await this.invitations.redeem(input.token, input.user.id, account.id, now);
      const studentId = inv.payload.studentId;
      if (inv.kind !== 'parent' || !inv.createdBy || !studentId) {
        throw new AppError('INVITATION_INVALID', 'Not a parent invitation');
      }
      if (studentId === account.id) {
        throw new AppError('INVITATION_NOT_FOR_YOU', 'The parent link was opened by the student', {
          reason: 'student_self',
        });
      }
      const teacher = await this.assertTeacherAuthorized(inv.createdBy);
      // the student row is locked so two parents accepting at once cannot exceed the limit of four
      const student = await this.accounts.findById(studentId, { forUpdate: true });
      if (!student || student.status === 'blocked') {
        throw new AppError('INVITATION_INVALID', 'Student account is not available');
      }
      // a teacher who parted with the student (link ended) may no longer attach parents to them
      const teacherLink = await this.links.findByPair(teacher.id, student.id);
      if (teacherLink?.status !== 'active') {
        throw new AppError('INVITATION_INVALID', 'Invitation is not valid', {
          reason: 'inviter_unauthorized',
        });
      }
      if (await this.family.findActive(account.id, student.id)) {
        throw new AppError('CONFLICT', 'Already a parent of this student', { reason: 'already_linked' });
      }
      assertParentLimit((await this.family.listActiveByStudent(student.id)).length);

      if (this.onboarding.needsQuestionnaire(account)) {
        if (!input.questionnaire) throw AppError.validation('Questionnaire is required for a new account');
        account = await this.onboarding.complete(account, input.questionnaire);
      }
      await this.onboarding.consentOnBehalfOf(account.id, student.id, input.consentVersion);

      const familyLink = await this.family.insert({
        parentId: account.id,
        studentId: student.id,
        invitedBy: teacher.id,
        invitationId: inv.id,
        confirmedAt: now,
      });
      await this.onboarding.ensureRole(account.id, 'PARENT', teacher.id);
      await this.accounts.upsertBotChat(account.id, 'parent', input.chatId);
      await this.audit.record({
        actorId: account.id,
        actorRole: 'PARENT',
        action: 'family.linked',
        entityType: 'family_link',
        entityId: familyLink.id,
        after: { studentId: student.id, invitedBy: teacher.id },
        source: 'bot',
      });
      await this.outbox.publish({
        type: 'family.activated',
        aggregateType: 'family_link',
        aggregateId: familyLink.id,
        payload: {
          familyLinkId: familyLink.id,
          parentId: account.id,
          studentId: student.id,
          teacherId: teacher.id,
        },
      });
      return { account, familyLink, student, teacher };
    });
  }
}
