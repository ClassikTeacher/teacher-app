import { Injectable } from '@nestjs/common';
import { Clock } from '@shared/time/clock.js';
import { FeatureService } from '@modules/access/features/feature.service.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import type { AccountRow, Bot } from '@modules/identity/schema.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { deferForQuietHours, isCritical, QUIET_CRITICAL_HORIZON_MS } from './delivery-policy.js';
import { NotificationPrefsRepository } from './notification-prefs.repository.js';
import { NotificationRepository } from './notification.repository.js';
import type { NotificationRow } from './schema.js';
import { botForRecipient, NOTIFICATION_TYPES, type NotificationTypeCode } from './types.js';

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface ScheduleInput {
  type: NotificationTypeCode;
  recipientId: string;
  payload?: Record<string, unknown>;
  /** NTF-08 idempotency key, e.g. `lesson.reminder:<lessonId>:<offset>:<version>`. */
  dedupeKey: string;
  /** Defaults to now; non-critical messages inside the recipient's quiet hours wait until they end (NTF-06). */
  dueAt?: Date;
  /** Overrides role-based routing (e.g. security messages → AuthBot). */
  bot?: Bot;
  /** The teacher whose copy settings apply (NTF-01); copies to parents need it. */
  teacherId?: string;
  /** Start of the lesson the message is about: decides the urgency of time-sensitive types (NTF-02, NTF-06). */
  lessonStartsAt?: Date | null;
  /** Reminders keep their time even inside quiet hours. */
  keepTime?: boolean;
  /** Accounts that must not receive a copy or a stand-in message (the parent who caused the event). */
  excludeAccountIds?: readonly string[];
}

/**
 * Schedules notifications in the current transaction; delivery is the worker's job (7.5). M4-05 adds the
 * recipient's mutes, quiet hours (NTF-06), copies to parents by the teacher's and the parent's settings
 * (NTF-01…03, feature `parents.cc`) and the parent standing in for a student whose bot is unreachable (NTF-04).
 */
@Injectable()
export class NotificationService {
  constructor(
    private readonly repo: NotificationRepository,
    private readonly accounts: AccountRepository,
    private readonly prefs: NotificationPrefsRepository,
    private readonly family: FamilyLinkRepository,
    private readonly features: FeatureService,
    private readonly clock: Clock,
  ) {}

  /** Returns the main row, or null when the account is blocked, unknown, muted, or the key already exists. */
  async schedule(input: ScheduleInput): Promise<NotificationRow | null> {
    const recipient = await this.accounts.findById(input.recipientId);
    if (!recipient || recipient.status === 'blocked') return null; // 3.8: blocked accounts get nothing
    const roles = await this.accounts.activeRoles(recipient.id);
    const now = this.clock.now();
    // NTF-02: within 48 h a cancellation / move cannot be muted; NTF-06: within 12 h it ignores quiet hours
    const critical = isCritical(input.type, input.lessonStartsAt ?? null, now);
    const urgent = isCritical(input.type, input.lessonStartsAt ?? null, now, QUIET_CRITICAL_HORIZON_MS);
    const type = NOTIFICATION_TYPES[input.type];
    const bot = input.bot ?? botForRecipient(roles);
    const isStudent = bot === 'student' && roles.includes('STUDENT');
    const muted = !critical && type.recipientCanDisable && (await this.isMuted(recipient.id, input.type));
    // NTF-04: the student's bot is gone and the teacher opted in → the parents get the message as the main one
    if (isStudent && input.teacherId && (await this.standInParents(recipient, input.teacherId))) {
      const parents = await this.parentsOf(recipient.id, input.excludeAccountIds);
      let first: NotificationRow | null = null;
      for (const parent of parents) {
        if (!critical && (await this.isMuted(parent.id, input.type))) continue;
        const row = await this.insertFor(parent, input, 'via_parent', recipient, urgent, null);
        first ??= row;
      }
      if (parents.length > 0) return first;
    }
    const row = muted
      ? null
      : await this.repo.insert({
          typeCode: input.type,
          recipientId: recipient.id,
          bot,
          payload: input.payload ?? {},
          dedupeKey: input.dedupeKey,
          dueAt: await this.dueFor(recipient, input.dueAt ?? now, urgent, input.keepTime),
        });
    // the parents' copies do not depend on the student's own mute (each parent has their own, NTF-02)
    if ((row || muted) && isStudent && input.teacherId)
      await this.copyToParents(recipient, input, critical, urgent, row?.id ?? null);
    return row;
  }

  /** How many rows with the key prefix a recipient got in the period (NTF-07 thresholds). */
  async countByPrefix(prefix: string, recipientId: string, from: Date, to: Date): Promise<number> {
    return this.repo.countByPrefixForRecipient(prefix, recipientId, from, to);
  }

  /** Cancels not-yet-sent notifications by key prefix, optionally for one recipient only (NTF-05). */
  async cancelByPrefix(prefix: string, recipientId?: string): Promise<number> {
    return this.repo.cancelByPrefix(prefix, recipientId);
  }

  /** NTF-01: the teacher's default for the type, overridden per student; the type's own default otherwise. */
  async ccEnabled(teacherId: string, studentId: string, type: NotificationTypeCode): Promise<boolean> {
    const [perStudent, defaults] = await Promise.all([
      this.prefs.settings(teacherId, 'cc_student', studentId),
      this.prefs.settings(teacherId, 'cc_default', null),
    ]);
    const override = perStudent.find((s) => s.typeCode === type);
    if (override) return override.enabled;
    const def = defaults.find((s) => s.typeCode === type);
    return def ? def.enabled : NOTIFICATION_TYPES[type].ccParentsByDefault;
  }

  private async copyToParents(
    student: AccountRow,
    input: ScheduleInput,
    critical: boolean,
    urgent: boolean,
    mainId: string | null,
  ): Promise<void> {
    if (!(await this.features.isEnabled(input.teacherId!, 'parents.cc'))) return;
    if (!(await this.ccEnabled(input.teacherId!, student.id, input.type))) return;
    for (const parent of await this.parentsOf(student.id, input.excludeAccountIds)) {
      // NTF-02: a parent may mute non-critical copies; critical ones always arrive
      if (!critical && (await this.isMuted(parent.id, input.type))) continue;
      await this.insertFor(parent, input, 'cc', student, urgent, mainId);
    }
  }

  private async insertFor(
    parent: AccountRow,
    input: ScheduleInput,
    route: 'cc' | 'via_parent',
    student: AccountRow,
    urgent: boolean,
    ccOfId: string | null,
  ): Promise<NotificationRow | null> {
    const dueAt = await this.dueFor(parent, input.dueAt ?? this.clock.now(), urgent, input.keepTime);
    return this.repo.insert({
      typeCode: input.type,
      recipientId: parent.id,
      bot: 'parent',
      payload: { ...(input.payload ?? {}), forName: esc(`${student.firstName} ${student.lastName}`.trim()) },
      dedupeKey: `${input.dedupeKey}:${route}:${parent.id}`,
      dueAt,
      ccOfId,
      route,
      forAccountId: student.id,
    });
  }

  private async parentsOf(studentId: string, exclude: readonly string[] = []): Promise<AccountRow[]> {
    const links = await this.family.listActiveByStudent(studentId);
    const parents = await this.accounts.findByIds(links.map((l) => l.parentId));
    return parents.filter((p) => p.status !== 'blocked' && !exclude.includes(p.id));
  }

  private async standInParents(student: AccountRow, teacherId: string): Promise<boolean> {
    const chat = await this.accounts.findBotChat(student.id, 'student');
    if (!chat || chat.isReachable) return false;
    return (await this.prefs.profile(teacherId)).deliverViaParent;
  }

  private async isMuted(accountId: string, type: NotificationTypeCode): Promise<boolean> {
    return (await this.prefs.settings(accountId, 'mute')).some((s) => s.typeCode === type && !s.enabled);
  }

  private async dueFor(
    recipient: AccountRow,
    dueAt: Date,
    urgent: boolean,
    keepTime?: boolean,
  ): Promise<Date> {
    if (urgent || keepTime) return dueAt;
    return deferForQuietHours(dueAt, await this.prefs.profile(recipient.id), recipient.timezone);
  }
}
