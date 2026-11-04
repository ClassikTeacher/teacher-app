import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { type Actor, assertRole, primaryRole } from '@modules/access/actor.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import type { AccountRow } from '@modules/identity/schema.js';
import { MessageTemplateRepository } from './message-template.repository.js';
import type { MessageTemplateRow, TeacherProfileRow, TemplateKind } from './schema.js';
import { SubjectRepository } from './subject.repository.js';
import { TeacherProfileRepository } from './teacher-profile.repository.js';
import {
  MAX_TEMPLATE_TEXT_LENGTH,
  MAX_TEMPLATES_PER_KIND,
  normalizeTeacherSettings,
  type TeacherSettingsPatch,
} from './teacher-settings.rules.js';

export interface TeacherSettings {
  account: AccountRow;
  profile: TeacherProfileRow;
}

const ACCOUNT_FIELDS = ['firstName', 'lastName', 'timezone'] as const;

/** «Настройки» in StaffBot and GET/PATCH /me (3.4): the teacher's own profile, defaults and reason templates. */
@Injectable()
export class TeacherSettingsUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly accounts: AccountRepository,
    private readonly profiles: TeacherProfileRepository,
    private readonly subjects: SubjectRepository,
    private readonly templates: MessageTemplateRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async get(actor: Actor): Promise<TeacherSettings> {
    assertRole(actor, 'TEACHER');
    const [account, profile] = await Promise.all([
      this.accounts.findById(actor.accountId),
      this.profiles.find(actor.accountId),
    ]);
    if (!account || !profile) throw AppError.notFound('teacher profile', actor.accountId);
    return { account, profile };
  }

  async update(actor: Actor, patch: TeacherSettingsPatch): Promise<TeacherSettings> {
    assertRole(actor, 'TEACHER');
    const clean = normalizeTeacherSettings(patch);
    if (Object.keys(clean).length === 0) throw AppError.validation('Nothing to update');
    if (clean.subjectIds) await this.assertSubjects(clean.subjectIds);
    return this.txm.run(async () => this.apply(actor, await this.locked(actor), clean));
  }

  /** Adds or removes one subject atomically under the profile lock; the last subject cannot be removed. */
  async toggleSubject(actor: Actor, subjectId: string): Promise<TeacherSettings> {
    assertRole(actor, 'TEACHER');
    return this.txm.run(async () => {
      const current = await this.locked(actor);
      const has = current.profile.subjectIds.includes(subjectId);
      const next = has
        ? current.profile.subjectIds.filter((id) => id !== subjectId)
        : [...current.profile.subjectIds, subjectId];
      if (next.length === 0) throw AppError.validation('At least one subject is required');
      if (!has) await this.assertSubjects([subjectId]);
      return this.apply(actor, current, { subjectIds: next });
    });
  }

  private async locked(actor: Actor): Promise<TeacherSettings> {
    const [account, profile] = await Promise.all([
      this.accounts.findById(actor.accountId, { forUpdate: true }),
      this.profiles.find(actor.accountId, { forUpdate: true }),
    ]);
    if (!account || !profile) throw AppError.notFound('teacher profile', actor.accountId);
    return { account, profile };
  }

  private async apply(
    actor: Actor,
    current: TeacherSettings,
    clean: TeacherSettingsPatch,
  ): Promise<TeacherSettings> {
    const fields = Object.keys(clean) as Array<keyof TeacherSettingsPatch>;
    const accountPatch = Object.fromEntries(
      ACCOUNT_FIELDS.filter((f) => clean[f] !== undefined).map((f) => [f, clean[f]]),
    ) as Partial<Pick<AccountRow, 'firstName' | 'lastName' | 'timezone'>>;
    const profilePatch = Object.fromEntries(
      fields.filter((f) => !(ACCOUNT_FIELDS as readonly string[]).includes(f)).map((f) => [f, clean[f]]),
    );
    // booking rules are a partial patch merged over the stored ones (5.5.5)
    if (clean.bookingRules)
      profilePatch['bookingRules'] = { ...current.profile.bookingRules, ...clean.bookingRules };
    const account =
      Object.keys(accountPatch).length > 0
        ? await this.accounts.update(actor.accountId, accountPatch)
        : current.account;
    const profile =
      Object.keys(profilePatch).length > 0
        ? await this.profiles.upsert(actor.accountId, profilePatch)
        : current.profile;
    await this.audit.record({
      actorId: actor.accountId,
      actorRole: primaryRole(actor),
      action: 'teacher.settings_updated',
      entityType: 'teacher_profile',
      entityId: actor.accountId,
      before: { fields, ...this.auditView(current, fields) },
      after: { fields, ...this.auditView({ account, profile }, fields) },
      source: actor.source,
      ip: actor.ip,
    });
    return { account, profile };
  }

  /** Changed values in full, except the free text of the default notice (length only). */
  private auditView(s: TeacherSettings, fields: Array<keyof TeacherSettingsPatch>): Record<string, unknown> {
    const view: Record<string, unknown> = {};
    for (const f of fields) {
      if (f === 'defaultNoticeText') view['defaultNoticeTextLength'] = s.profile.defaultNoticeText.length;
      else if ((ACCOUNT_FIELDS as readonly string[]).includes(f))
        view[f] = s.account[f as (typeof ACCOUNT_FIELDS)[number]];
      else view[f] = (s.profile as unknown as Record<string, unknown>)[f];
    }
    return view;
  }

  private async assertSubjects(ids: string[]): Promise<void> {
    const found = await this.subjects.findByIds(ids);
    if (found.length !== ids.length || found.some((x) => !x.isActive)) {
      throw AppError.validation('Unknown or inactive subject');
    }
  }

  async listTemplates(actor: Actor, kind: TemplateKind): Promise<MessageTemplateRow[]> {
    assertRole(actor, 'TEACHER');
    return this.templates.listActive(actor.accountId, kind);
  }

  async addTemplate(actor: Actor, kind: TemplateKind, text: string): Promise<MessageTemplateRow> {
    assertRole(actor, 'TEACHER');
    const clean = text.trim();
    if (!clean || clean.length > MAX_TEMPLATE_TEXT_LENGTH) {
      throw AppError.validation('Template text is required and limited', { max: MAX_TEMPLATE_TEXT_LENGTH });
    }
    return this.txm.run(async () => {
      const existing = await this.templates.listActive(actor.accountId, kind);
      if (existing.length >= MAX_TEMPLATES_PER_KIND) {
        throw new AppError('LIMIT_EXCEEDED', 'Too many templates', {
          limit: 'maxTemplates',
          max: MAX_TEMPLATES_PER_KIND,
        });
      }
      const position = (existing.at(-1)?.position ?? 0) + 10;
      return this.templates.insert({ ownerId: actor.accountId, kind, text: clean, position });
    });
  }

  async removeTemplate(actor: Actor, templateId: string): Promise<void> {
    assertRole(actor, 'TEACHER');
    await this.txm.run(async () => {
      const row = await this.templates.findById(templateId);
      if (!row || row.ownerId !== actor.accountId) throw AppError.notFound('template', templateId);
      if (!(await this.templates.archive(row.id, this.clock.now()))) {
        throw new AppError('CONFLICT', 'Template is already removed');
      }
    });
  }
}
