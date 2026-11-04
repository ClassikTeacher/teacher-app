import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { isValidTimezone } from '@shared/time/timezone.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { CONSENT_DOCUMENT, CONSENT_VERSION } from '@modules/identity/consent.js';
import type { AccountRow } from '@modules/identity/schema.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { SubjectRepository } from './subject.repository.js';
import { MAX_LESSON_DURATION_MIN, MIN_LESSON_DURATION_MIN } from './teacher-profile.defaults.js';
import { TeacherProfileRepository } from './teacher-profile.repository.js';

export interface StaffOnboardingInput {
  accountId: string;
  firstName: string;
  lastName: string;
  /** Telegram username; mandatory for staff (AUTH-04). */
  username: string | null;
  timezone: string;
  locale: 'ru';
  consentVersion: string;
  /** Present when the account holds the TEACHER role. */
  teacher?: {
    subjectIds: string[];
    defaultDurationMin: number;
    defaultNoticeText: string;
  };
  invitedBy: string | null;
}

/**
 * UC-05 step 2: the questionnaire in AuthBot is saved and the account becomes `active` (3.8).
 * Consent, profile, audit and the `teacher.onboarded` event share one transaction.
 */
@Injectable()
export class CompleteStaffOnboardingUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly accounts: AccountRepository,
    private readonly profiles: TeacherProfileRepository,
    private readonly subjects: SubjectRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  async execute(input: StaffOnboardingInput): Promise<AccountRow> {
    this.validate(input);
    const now = this.clock.now();
    return this.txm.run(async () => {
      const account = await this.accounts.findById(input.accountId, { forUpdate: true });
      if (!account) throw AppError.notFound('account', input.accountId);
      if (account.status === 'blocked') throw new AppError('ACCOUNT_BLOCKED', 'Account is blocked');
      const roles = await this.accounts.activeRoles(account.id);
      const isTeacher = roles.includes('TEACHER');
      if (isTeacher && !input.teacher) throw AppError.validation('Teacher questionnaire is required');
      if (input.teacher) {
        const found = await this.subjects.findByIds(input.teacher.subjectIds);
        if (found.length !== input.teacher.subjectIds.length || found.some((s) => !s.isActive)) {
          throw AppError.validation('Unknown or inactive subject');
        }
      }

      const updated = await this.accounts.update(account.id, {
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        username: input.username,
        timezone: input.timezone,
        locale: input.locale,
        status: 'active',
      });
      await this.accounts.addConsent({
        accountId: account.id,
        document: CONSENT_DOCUMENT,
        version: input.consentVersion,
        onBehalfOf: null,
        source: 'bot',
      });
      if (input.teacher) {
        await this.profiles.upsert(account.id, {
          subjectIds: input.teacher.subjectIds,
          defaultDurationMin: input.teacher.defaultDurationMin,
          defaultNoticeText: input.teacher.defaultNoticeText.trim(),
          onboardedAt: now,
        });
      }
      await this.audit.record({
        actorId: account.id,
        actorRole: isTeacher ? 'TEACHER' : (roles[0] ?? null),
        action: 'account.onboarded',
        entityType: 'account',
        entityId: account.id,
        before: { status: account.status },
        after: { status: 'active', roles, consentVersion: input.consentVersion },
        source: 'bot',
      });
      if (isTeacher) {
        await this.outbox.publish({
          type: 'teacher.onboarded',
          aggregateType: 'account',
          aggregateId: account.id,
          payload: { accountId: account.id, invitedBy: input.invitedBy },
        });
      }
      return updated;
    });
  }

  private validate(input: StaffOnboardingInput): void {
    if (!input.firstName.trim()) throw AppError.validation('First name is required');
    if (!input.username) throw AppError.validation('Telegram username is required for staff accounts');
    if (!isValidTimezone(input.timezone)) throw AppError.validation('Unknown timezone');
    if (input.consentVersion !== CONSENT_VERSION) throw AppError.validation('Outdated consent version');
    if (input.teacher) {
      const { subjectIds, defaultDurationMin, defaultNoticeText } = input.teacher;
      if (subjectIds.length === 0) throw AppError.validation('At least one subject is required');
      if (
        !Number.isInteger(defaultDurationMin) ||
        defaultDurationMin < MIN_LESSON_DURATION_MIN ||
        defaultDurationMin > MAX_LESSON_DURATION_MIN
      ) {
        throw AppError.validation('Lesson duration is out of range');
      }
      if (!defaultNoticeText.trim()) throw AppError.validation('Default notice text is required');
    }
  }
}
