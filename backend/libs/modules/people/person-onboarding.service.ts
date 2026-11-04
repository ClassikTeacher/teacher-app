import { Injectable } from '@nestjs/common';
import { AppError } from '@shared/errors/app-error.js';
import { isValidTimezone } from '@shared/time/timezone.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { CONSENT_DOCUMENT, CONSENT_VERSION } from '@modules/identity/consent.js';
import type { TelegramIdentity } from '@modules/identity/redeem-staff-invitation.use-case.js';
import type { AccountRow } from '@modules/identity/schema.js';

/** Answers of the simplified questionnaire of students and parents (3.8). */
export interface PersonQuestionnaire {
  firstName: string;
  lastName: string;
  timezone: string;
  consentVersion: string;
}

export const MAX_PERSON_NAME_LENGTH = 60;

/**
 * Shared pieces of student and parent onboarding (3.8 "упрощённый онбординг"): the account is created on
 * first contact and activated once the questionnaire is answered; existing active accounts skip it.
 * Must run inside the caller's transaction.
 */
@Injectable()
export class PersonOnboardingService {
  constructor(private readonly accounts: AccountRepository) {}

  /** Finds the account of the Telegram user or creates it in `onboarding`; refreshes the username (3.1). */
  async ensureAccount(user: TelegramIdentity): Promise<{ account: AccountRow; created: boolean }> {
    const existing = await this.accounts.findByTelegramUserId(user.id);
    if (existing?.status === 'blocked') throw new AppError('ACCOUNT_BLOCKED', 'Account is blocked');
    if (existing) {
      const account =
        existing.username === (user.username ?? null)
          ? existing
          : await this.accounts.update(existing.id, { username: user.username ?? null });
      return { account, created: false };
    }
    const first = await this.accounts.insertOrGetByTelegramUserId({
      telegramUserId: user.id,
      firstName: user.firstName,
      lastName: user.lastName ?? '',
      username: user.username ?? null,
      status: 'onboarding',
    });
    if (first.row.status === 'blocked') throw new AppError('ACCOUNT_BLOCKED', 'Account is blocked');
    return { account: first.row, created: first.created };
  }

  /** Whether the account still needs the questionnaire before it may act (status not yet active). */
  needsQuestionnaire(account: AccountRow): boolean {
    return account.status !== 'active';
  }

  validate(q: PersonQuestionnaire): void {
    if (!q.firstName.trim()) throw AppError.validation('First name is required');
    if (q.firstName.length + q.lastName.length > MAX_PERSON_NAME_LENGTH + 1) {
      throw AppError.validation('Name is too long');
    }
    if (!isValidTimezone(q.timezone)) throw AppError.validation('Unknown timezone');
    if (q.consentVersion !== CONSENT_VERSION) throw AppError.validation('Outdated consent version');
  }

  /** Saves the questionnaire, records the consent and activates the account. */
  async complete(account: AccountRow, q: PersonQuestionnaire): Promise<AccountRow> {
    this.validate(q);
    // a teacher or admin finishes the staff questionnaire in AuthBot; this one must not activate them
    const roles = await this.accounts.activeRoles(account.id);
    if (roles.some((r) => r === 'TEACHER' || r === 'ADMIN' || r === 'SUPER_ADMIN'))
      throw AppError.forbidden('Staff accounts finish onboarding in AuthBot', { reason: 'staff_onboarding' });
    const updated = await this.accounts.update(account.id, {
      firstName: q.firstName.trim(),
      lastName: q.lastName.trim(),
      timezone: q.timezone,
      status: 'active',
    });
    await this.accounts.addConsent({
      accountId: account.id,
      document: CONSENT_DOCUMENT,
      version: q.consentVersion,
      onBehalfOf: null,
      source: 'bot',
    });
    return updated;
  }

  /** A parent accepts the terms as the legal representative of the child (10.2, `consent.on_behalf_of`). */
  async consentOnBehalfOf(parentId: string, studentId: string, version: string): Promise<void> {
    if (version !== CONSENT_VERSION) throw AppError.validation('Outdated consent version');
    await this.accounts.addConsent({
      accountId: parentId,
      document: CONSENT_DOCUMENT,
      version,
      onBehalfOf: studentId,
      source: 'bot',
    });
  }

  /** Contextual roles (3.1) appear with the first link and are never revoked with it. */
  async ensureRole(
    accountId: string,
    role: 'STUDENT' | 'PARENT',
    grantedBy: string | null,
  ): Promise<boolean> {
    const roles = await this.accounts.activeRoles(accountId);
    if (roles.includes(role)) return false;
    await this.accounts.grantRole(accountId, role, grantedBy);
    return true;
  }
}
