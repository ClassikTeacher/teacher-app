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
import { JournalsPort } from '../journals.port.js';
import { type PersonQuestionnaire, PersonOnboardingService } from '../person-onboarding.service.js';
import type { SubjectRow, TeacherStudentRow } from '../schema.js';
import { StudentProfileRepository } from '../student-profile.repository.js';
import { SubjectRepository } from '../subject.repository.js';
import { acceptOutcome, MAX_GRADE_LENGTH } from './link.rules.js';
import { TeacherStudentRepository } from './teacher-student.repository.js';

export interface StudentInvitationPreview {
  invitation: PeekedInvitation;
  link: TeacherStudentRow;
  teacher: AccountRow;
  subjects: SubjectRow[];
}

export interface StudentQuestionnaire extends PersonQuestionnaire {
  grade?: string | null;
}

export interface AcceptStudentInput {
  user: TelegramIdentity;
  token: string;
  /** Private chat with StudentBot, registered right away so the first notifications can be delivered. */
  chatId: number;
  /** Required unless the account is already active (UC-10 step 6 applies to new users only). */
  questionnaire?: StudentQuestionnaire;
}

export interface AcceptStudentResult {
  account: AccountRow;
  link: TeacherStudentRow;
  teacher: AccountRow;
  reopened: boolean;
}

/**
 * UC-10 steps 5–7 on the student's side: preview, accept (with the simplified questionnaire for new accounts)
 * or decline a personal invitation. Accepting consumes the token, activates the card (`pending` → `active`,
 * or reopens an `ended` link of the same pair: new period, same journals), grants STUDENT, provisions journals.
 */
@Injectable()
export class AcceptStudentInvitationUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly invitations: InvitationService,
    private readonly accounts: AccountRepository,
    private readonly links: TeacherStudentRepository,
    private readonly profiles: StudentProfileRepository,
    private readonly subjects: SubjectRepository,
    private readonly onboarding: PersonOnboardingService,
    private readonly journals: JournalsPort,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  /** Null when the token is unknown or not a student invitation; `check` says whether it can still be used. */
  async peek(token: string, telegramUserId: number): Promise<StudentInvitationPreview | null> {
    const peeked = await this.invitations.peek(token, telegramUserId, this.clock.now());
    if (!peeked || peeked.kind !== 'student' || !peeked.createdBy) return null;
    const [link, teacher] = await Promise.all([
      this.links.findByInvitationId(peeked.id),
      this.accounts.findById(peeked.createdBy),
    ]);
    if (!link || !teacher) return null;
    const subjects = await this.subjects.findByIds(link.subjectIds);
    return { invitation: peeked, link, teacher, subjects };
  }

  /** INV-01 at redeem time: a blocked teacher or one who lost the role invalidates their links. */
  private async assertTeacherAuthorized(teacherId: string): Promise<AccountRow> {
    const teacher = await this.accounts.findById(teacherId);
    const roles = teacher ? await this.accounts.activeRoles(teacher.id) : [];
    if (!teacher || teacher.status !== 'active' || !roles.includes('TEACHER')) {
      throw new AppError('INVITATION_INVALID', 'Invitation is not valid', { reason: 'inviter_unauthorized' });
    }
    return teacher;
  }

  async accept(input: AcceptStudentInput): Promise<AcceptStudentResult> {
    const now = this.clock.now();
    if (input.questionnaire?.grade && input.questionnaire.grade.length > MAX_GRADE_LENGTH) {
      throw AppError.validation('Grade is too long');
    }
    return this.txm.run(async () => {
      const { account: initial } = await this.onboarding.ensureAccount(input.user);
      let account = initial;
      const inv = await this.invitations.redeem(input.token, input.user.id, account.id, now);
      if (inv.kind !== 'student' || !inv.createdBy) {
        throw new AppError('INVITATION_INVALID', 'Not a student invitation');
      }
      const pending = await this.links.findByInvitationId(inv.id, { forUpdate: true });
      if (!pending || pending.status !== 'pending') {
        throw new AppError('INVITATION_INVALID', 'Invitation card is no longer pending');
      }
      if (pending.teacherId !== inv.createdBy) {
        throw new AppError('INVITATION_INVALID', 'Card and invitation belong to different teachers');
      }
      const teacher = await this.assertTeacherAuthorized(inv.createdBy);
      if (teacher.id === account.id) {
        throw new AppError('INVITATION_NOT_FOR_YOU', 'A teacher cannot be their own student');
      }
      await this.links.lockPair(teacher.id, account.id);
      const existing = await this.links.findByPair(teacher.id, account.id, { forUpdate: true });
      const outcome = acceptOutcome(existing); // throws CONFLICT when already linked (UC-10 5б)

      if (this.onboarding.needsQuestionnaire(account)) {
        if (!input.questionnaire) throw AppError.validation('Questionnaire is required for a new account');
        account = await this.onboarding.complete(account, input.questionnaire);
      }
      const profile = await this.profiles.find(account.id);
      const grade = input.questionnaire?.grade?.trim() || profile?.grade || pending.inviteGrade || null;
      await this.profiles.upsert(account.id, {
        grade,
        ...(profile?.onboardedAt ? {} : { onboardedAt: now }),
      });

      let link: TeacherStudentRow;
      if (outcome === 'reopen' && existing) {
        // the old row keeps its journals; the pending card hands over its settings and is retired
        await this.links.update(pending.id, { status: 'cancelled', invitationId: null });
        link = await this.links.update(existing.id, {
          status: 'active',
          invitationId: inv.id,
          subjectIds: pending.subjectIds,
          maxLessonsPerWeek: pending.maxLessonsPerWeek,
          alias: existing.alias ?? pending.inviteName,
          startedAt: now,
          endedAt: null,
          endedBy: null,
          endReason: null,
          endMessage: null,
        });
      } else {
        link = await this.links.update(pending.id, {
          status: 'active',
          studentId: account.id,
          alias: pending.inviteName,
          startedAt: now,
        });
      }
      await this.links.openPeriod(link.id, now);
      await this.onboarding.ensureRole(account.id, 'STUDENT', teacher.id);
      await this.accounts.upsertBotChat(account.id, 'student', input.chatId);
      await this.journals.ensureForLink({
        linkId: link.id,
        teacherId: teacher.id,
        studentId: account.id,
        subjectIds: link.subjectIds,
      });
      await this.audit.record({
        actorId: account.id,
        actorRole: 'STUDENT',
        action: 'link.activated',
        entityType: 'teacher_student',
        entityId: link.id,
        before: { status: existing?.status ?? 'pending' },
        after: { status: 'active', teacherId: teacher.id, reopened: outcome === 'reopen' },
        source: 'bot',
      });
      await this.outbox.publish({
        type: 'link.activated',
        aggregateType: 'teacher_student',
        aggregateId: link.id,
        payload: {
          linkId: link.id,
          teacherId: teacher.id,
          studentId: account.id,
          invitationId: inv.id,
          reopened: outcome === 'reopen',
        },
      });
      return { account, link, teacher, reopened: outcome === 'reopen' };
    });
  }

  /** UC-10 5а: the token is burnt, the card becomes `declined`, the teacher is told. */
  async decline(user: TelegramIdentity, token: string): Promise<TeacherStudentRow> {
    const now = this.clock.now();
    return this.txm.run(async () => {
      const account = await this.accounts.findByTelegramUserId(user.id);
      if (account?.status === 'blocked') throw new AppError('ACCOUNT_BLOCKED', 'Account is blocked');
      const inv = await this.invitations.redeem(token, user.id, account?.id ?? null, now);
      if (inv.kind !== 'student') throw new AppError('INVITATION_INVALID', 'Not a student invitation');
      const pending = await this.links.findByInvitationId(inv.id, { forUpdate: true });
      if (!pending || pending.status !== 'pending') {
        throw new AppError('INVITATION_INVALID', 'Invitation card is no longer pending');
      }
      const link = await this.links.update(pending.id, { status: 'declined' });
      await this.audit.record({
        actorId: account?.id ?? null,
        actorRole: 'STUDENT',
        action: 'link.declined',
        entityType: 'teacher_student',
        entityId: link.id,
        before: { status: 'pending' },
        after: { status: 'declined' },
        source: 'bot',
      });
      await this.outbox.publish({
        type: 'link.declined',
        aggregateType: 'teacher_student',
        aggregateId: link.id,
        payload: { linkId: link.id, teacherId: link.teacherId, invitationId: inv.id },
      });
      return link;
    });
  }
}
