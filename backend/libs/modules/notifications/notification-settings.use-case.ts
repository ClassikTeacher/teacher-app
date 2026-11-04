import { Injectable } from '@nestjs/common';
import { AppError } from '@shared/errors/app-error.js';
import { type Actor, assertActive, assertRole, primaryRole } from '@modules/access/actor.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { normalizeOffsets, timeToMinutes } from './delivery-policy.js';
import { NotificationPrefsRepository, type ProfilePatch } from './notification-prefs.repository.js';
import type { NotificationProfileRow, NotificationSettingRow } from './schema.js';
import {
  CC_CONFIGURABLE_TYPES,
  isNotificationType,
  MUTEABLE_TYPES,
  NOTIFICATION_TYPES,
  type NotificationTypeCode,
  PARENT_MUTEABLE_TYPES,
} from './types.js';

export interface NotificationSettingsView {
  profile: NotificationProfileRow;
  /** Types the person has switched off for themselves. */
  muted: NotificationTypeCode[];
  /** Teacher only: copy defaults per type (true = parents get a copy). */
  ccDefaults: Array<{ type: NotificationTypeCode; enabled: boolean }>;
}

export interface StudentCcView {
  /** Per type: the effective value and whether it is the teacher's default or an override. */
  items: Array<{ type: NotificationTypeCode; enabled: boolean; overridden: boolean }>;
}

const hhmm = (value: string): string => {
  const minutes = timeToMinutes(value);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;
};

/** Settings screens of the three bots (5.13.2–5.13.4) and the per-student copy override in the card (NTF-01). */
@Injectable()
export class NotificationSettingsUseCase {
  constructor(
    private readonly prefs: NotificationPrefsRepository,
    private readonly links: TeacherStudentRepository,
    private readonly audit: AuditService,
  ) {}

  async view(actor: Actor): Promise<NotificationSettingsView> {
    assertActive(actor);
    const [profile, mutes, cc] = await Promise.all([
      this.prefs.profile(actor.accountId),
      this.prefs.settings(actor.accountId, 'mute'),
      actor.roles.includes('TEACHER') ? this.prefs.settings(actor.accountId, 'cc_default', null) : [],
    ]);
    const ccDefaults = CC_CONFIGURABLE_TYPES.map((type) => {
      const row = cc.find((s) => s.typeCode === type);
      return { type, enabled: row ? row.enabled : NOTIFICATION_TYPES[type].ccParentsByDefault };
    });
    return {
      profile,
      muted: mutes
        .filter((m) => !m.enabled && isNotificationType(m.typeCode))
        .map((m) => m.typeCode as NotificationTypeCode),
      ccDefaults,
    };
  }

  /** Types this person may switch off: their own muteable messages, or non-critical copies for a parent. */
  muteable(actor: Actor): readonly NotificationTypeCode[] {
    const parentOnly =
      actor.roles.includes('PARENT') && !actor.roles.includes('STUDENT') && !actor.roles.includes('TEACHER');
    return parentOnly ? PARENT_MUTEABLE_TYPES : MUTEABLE_TYPES;
  }

  async toggleOffset(actor: Actor, offset: number): Promise<NotificationProfileRow> {
    assertActive(actor);
    const current = (await this.prefs.profile(actor.accountId)).reminderOffsetsMin;
    const next = current.includes(offset) ? current.filter((o) => o !== offset) : [...current, offset];
    return this.patch(actor, { reminderOffsetsMin: normalizeOffsets(next) });
  }

  async setQuietHours(actor: Actor, from: string, to: string): Promise<NotificationProfileRow> {
    assertActive(actor);
    return this.patch(actor, { quietEnabled: true, quietFrom: hhmm(from), quietTo: hhmm(to) });
  }

  async toggleQuiet(actor: Actor): Promise<NotificationProfileRow> {
    assertActive(actor);
    const profile = await this.prefs.profile(actor.accountId);
    return this.patch(actor, { quietEnabled: !profile.quietEnabled });
  }

  async setDigestTime(actor: Actor, time: string): Promise<NotificationProfileRow> {
    assertRole(actor, 'TEACHER');
    return this.patch(actor, { digestEnabled: true, digestTime: hhmm(time) });
  }

  async toggleDigest(actor: Actor): Promise<NotificationProfileRow> {
    assertRole(actor, 'TEACHER');
    const profile = await this.prefs.profile(actor.accountId);
    return this.patch(actor, { digestEnabled: !profile.digestEnabled });
  }

  async toggleViaParent(actor: Actor): Promise<NotificationProfileRow> {
    assertRole(actor, 'TEACHER');
    const profile = await this.prefs.profile(actor.accountId);
    return this.patch(actor, { deliverViaParent: !profile.deliverViaParent });
  }

  /** The person's own mute for a type they may disable (critical ones are refused). */
  async toggleMute(actor: Actor, type: NotificationTypeCode): Promise<NotificationSettingRow> {
    assertActive(actor);
    if (!this.muteable(actor).includes(type))
      throw AppError.validation('This message cannot be switched off', { type });
    const current = (await this.prefs.settings(actor.accountId, 'mute')).find((s) => s.typeCode === type);
    const enabled = current ? !current.enabled : false;
    await this.record(actor, 'notification.mute', { type, enabled });
    return this.prefs.setSetting(actor.accountId, 'mute', type, enabled);
  }

  async toggleCcDefault(actor: Actor, type: NotificationTypeCode): Promise<NotificationSettingRow> {
    assertRole(actor, 'TEACHER');
    if (!CC_CONFIGURABLE_TYPES.includes(type)) throw AppError.validation('Not a copyable type', { type });
    const current = (await this.view(actor)).ccDefaults.find((c) => c.type === type)!;
    await this.record(actor, 'notification.cc_default', { type, enabled: !current.enabled });
    return this.prefs.setSetting(actor.accountId, 'cc_default', type, !current.enabled);
  }

  /** NTF-01: the teacher's per-student view (own active student only, 8.0). */
  async studentCc(actor: Actor, studentId: string): Promise<StudentCcView> {
    assertRole(actor, 'TEACHER');
    await this.ownStudent(actor, studentId);
    const [defaults, overrides] = await Promise.all([
      this.view(actor),
      this.prefs.settings(actor.accountId, 'cc_student', studentId),
    ]);
    return {
      items: defaults.ccDefaults.map((d) => {
        const o = overrides.find((s) => s.typeCode === d.type);
        return { type: d.type, enabled: o ? o.enabled : d.enabled, overridden: !!o };
      }),
    };
  }

  async toggleStudentCc(actor: Actor, studentId: string, type: NotificationTypeCode): Promise<void> {
    assertRole(actor, 'TEACHER');
    if (!CC_CONFIGURABLE_TYPES.includes(type)) throw AppError.validation('Not a copyable type', { type });
    const item = (await this.studentCc(actor, studentId)).items.find((i) => i.type === type)!;
    await this.record(actor, 'notification.cc_student', { studentId, type, enabled: !item.enabled });
    await this.prefs.setSetting(actor.accountId, 'cc_student', type, !item.enabled, studentId);
  }

  async resetStudentCc(actor: Actor, studentId: string): Promise<void> {
    assertRole(actor, 'TEACHER');
    await this.ownStudent(actor, studentId);
    for (const type of CC_CONFIGURABLE_TYPES)
      await this.prefs.clearSetting(actor.accountId, 'cc_student', type, studentId);
    await this.record(actor, 'notification.cc_student_reset', { studentId });
  }

  private async ownStudent(actor: Actor, studentId: string): Promise<void> {
    const link = await this.links.findByPair(actor.accountId, studentId);
    if (link?.status !== 'active') throw AppError.notFound('student', studentId);
  }

  private async patch(actor: Actor, patch: ProfilePatch): Promise<NotificationProfileRow> {
    await this.record(actor, 'notification.profile', patch);
    return this.prefs.upsertProfile(actor.accountId, patch);
  }

  private async record(actor: Actor, action: string, after: Record<string, unknown>): Promise<void> {
    await this.audit.record({
      actorId: actor.accountId,
      actorRole: primaryRole(actor),
      action,
      entityType: 'notification_settings',
      entityId: actor.accountId,
      after,
      source: actor.source,
      ip: actor.ip,
    });
  }
}
