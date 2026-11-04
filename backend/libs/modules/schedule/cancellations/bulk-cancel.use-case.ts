import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock, DAY_MS } from '@shared/time/clock.js';
import { type Actor, assertActive, assertRole } from '@modules/access/actor.js';
import { FeatureService } from '@modules/access/features/feature.service.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import type { TeacherProfileRow } from '@modules/people/schema.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { AvailabilityRepository } from '../availability/availability.repository.js';
import { AvailabilityUseCase, MAX_EXCEPTIONS_PER_TEACHER } from '../availability/availability.use-case.js';
import { LessonRepository } from '../lessons/lesson.repository.js';
import type { Interval, LessonRow } from '../schema.js';
import { type CancelAs, type CancelContext, CancelLessonUseCase } from './cancel-lesson.use-case.js';
import { type CancelOutcome, checkCancel, normalizeCancelReason } from './cancel.rules.js';
import { CancellationRepository } from './cancellation.repository.js';

/** Longest period a bulk operation may cover. */
export const MAX_BULK_RANGE_DAYS = 62;
export const MAX_BULK_LESSONS = 200;

export type TeacherSelection =
  | { lessonIds: readonly string[] }
  | { range: Interval; target?: { studentId: string } | { groupId: string } };

export type PersonSelection = { lessonIds: readonly string[] } | { range: Interval; teacherId?: string };

export interface BulkItem {
  lesson: LessonRow;
  studentIds: string[];
  outcome: CancelOutcome;
  isLate: boolean;
}

export interface ExcludedItem {
  lesson: LessonRow;
  /** Error code of the rule that forbids it (CNL-02, CNL-07, LES-03), or ALREADY_REPORTED / NOT_PARTICIPANT. */
  code: string;
  cutoffHours?: number;
}

/** Too many lessons for one batch: the caller narrows the period (silent truncation would mislead, CNL-10). */
function assertBatchSize(rows: readonly LessonRow[]): void {
  if (rows.length > MAX_BULK_LESSONS)
    throw AppError.validation('Too many lessons for one batch', {
      max: MAX_BULK_LESSONS,
      count: rows.length,
    });
}

const excludedCode = (error: AppError): string =>
  error.code === 'CONFLICT' && error.details?.['reason'] === 'already_reported'
    ? 'ALREADY_REPORTED'
    : error.code;

export interface BulkPreview {
  items: BulkItem[];
  excluded: ExcludedItem[];
  lateCount: number;
}

export interface BulkReason {
  reason: string;
  templateId?: string | null;
}

export interface BulkResult extends BulkPreview {
  cancellationId: string | null;
  /** Days closed for booking (teacher option 5.7.5 💡), ISO dates in the teacher's zone. */
  closedDays: string[];
}

function assertRange(range: Interval): void {
  if (range.end.getTime() <= range.start.getTime())
    throw AppError.validation('Range end must be after its start');
  if (range.end.getTime() - range.start.getTime() > MAX_BULK_RANGE_DAYS * DAY_MS)
    throw AppError.validation('Range is too long', { maxDays: MAX_BULK_RANGE_DAYS });
}

/**
 * UC-22 / UC-23 (5.7.5, feature `bulk.cancel`): many lessons, one reason, one transaction (CNL-10). The teacher
 * cancels several, a period, or a student's / group's lessons in a period; a student or a parent cancels their
 * lessons in a period at every teacher or at one, or several from a list — group lessons become absence notices
 * (CNL-03) and lessons the rules forbid are excluded with the reason. Each recipient gets one summary message
 * (NTF-07) from the `cancellation.bulk` event; the per-lesson events still drop reminders.
 */
@Injectable()
export class BulkCancelUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly lessons: LessonRepository,
    private readonly single: CancelLessonUseCase,
    private readonly cancellations: CancellationRepository,
    private readonly profiles: TeacherProfileRepository,
    private readonly links: TeacherStudentRepository,
    private readonly family: FamilyLinkRepository,
    private readonly accounts: AccountRepository,
    private readonly availability: AvailabilityUseCase,
    private readonly exceptions: AvailabilityRepository,
    private readonly features: FeatureService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  // --- teacher (UC-22) ------------------------------------------------------------------------

  async previewTeacher(actor: Actor, selection: TeacherSelection): Promise<BulkPreview> {
    assertRole(actor, 'TEACHER');
    await this.features.assertEnabled(actor.accountId, 'bulk.cancel');
    const profile = await this.profileOf(actor.accountId);
    return this.assessTeacher(await this.selectTeacher(actor.accountId, selection), profile);
  }

  async executeTeacher(
    actor: Actor,
    selection: TeacherSelection,
    input: BulkReason & { closeWindows?: boolean },
  ): Promise<BulkResult> {
    assertRole(actor, 'TEACHER');
    await this.features.assertEnabled(actor.accountId, 'bulk.cancel');
    const reason = normalizeCancelReason(input.reason);
    const now = this.clock.now();
    const profile = await this.profileOf(actor.accountId);
    // 5.7.5 💡: windows close for a whole period only, never for one student's or group's lessons
    const closeWindows = !!input.closeWindows && 'range' in selection && !selection.target;
    return this.txm.run(async () => {
      const chosen = await this.selectTeacher(actor.accountId, selection);
      const locked = await this.lessons.lockByIds(chosen.map((l) => l.id));
      const preview = await this.assessTeacher(locked, profile);
      if (preview.items.length === 0) return { ...preview, cancellationId: null, closedDays: [] };
      const templateId = await this.single.ownTemplate(actor.accountId, input.templateId);
      const days = closeWindows
        ? await this.daysToClose(actor, (selection as { range: Interval }).range)
        : [];
      const cancellation = await this.cancellations.insert({
        initiatorId: actor.accountId,
        initiatorRole: 'TEACHER',
        kind: 'bulk',
        reason,
        templateId,
        createdAt: now,
      });
      const ctx: CancelContext = {
        cancellation,
        role: 'TEACHER',
        actorId: actor.accountId,
        source: actor.source,
        ip: actor.ip,
      };
      for (const item of preview.items) await this.single.cancelLocked(item.lesson, ctx, item.isLate, now);
      const closedDays: string[] = [];
      for (const iso of days) {
        await this.availability.addException(actor, { date: iso, kind: 'closed' });
        closedDays.push(iso);
      }
      await this.publish(ctx, preview.items);
      return { ...preview, cancellationId: cancellation.id, closedDays };
    });
  }

  /** The teacher's scheduled lessons of the selection (8.0: own only; unknown ids are ignored). */
  private async selectTeacher(teacherId: string, selection: TeacherSelection): Promise<LessonRow[]> {
    if ('lessonIds' in selection) {
      const ids = [...new Set(selection.lessonIds)].slice(0, MAX_BULK_LESSONS);
      return (await this.lessons.findByIds(ids)).filter((l) => l.teacherId === teacherId);
    }
    assertRange(selection.range);
    let rows = await this.lessons.listByTeacher(teacherId, selection.range, ['scheduled']);
    assertBatchSize(rows);
    const target = selection.target;
    if (target && 'groupId' in target) rows = rows.filter((l) => l.groupId === target.groupId);
    if (target && 'studentId' in target) {
      const members = await this.lessons.listParticipantsOf(rows.map((l) => l.id));
      rows = rows.filter(
        (l) => l.groupId === null && (members.get(l.id) ?? []).some((p) => p.studentId === target.studentId),
      );
    }
    return rows;
  }

  private async assessTeacher(rows: LessonRow[], profile: TeacherProfileRow): Promise<BulkPreview> {
    const now = this.clock.now();
    const members = await this.lessons.listParticipantsOf(rows.map((l) => l.id));
    const items: BulkItem[] = [];
    const excluded: ExcludedItem[] = [];
    for (const lesson of rows) {
      try {
        const check = checkCancel({ role: 'TEACHER', lesson, profile, now });
        items.push({ lesson, studentIds: (members.get(lesson.id) ?? []).map((p) => p.studentId), ...check });
      } catch (error) {
        if (!AppError.is(error)) throw error;
        excluded.push({ lesson, code: excludedCode(error) });
      }
    }
    return { items, excluded, lateCount: items.filter((i) => i.isLate).length };
  }

  /**
   * 5.7.5 💡 «закрыть окна на этот период»: whole closed days from today to the range end (teacher's zone),
   * minus days already closed. Checked against the exceptions limit *before* anything is cancelled, so a
   * limit hit cannot throw the batch away after the teacher confirmed (CNL-10).
   */
  private async daysToClose(actor: Actor, range: Interval): Promise<string[]> {
    const zone = (await this.accounts.findById(actor.accountId))?.timezone ?? 'UTC';
    const today = DateTime.fromJSDate(this.clock.now(), { zone }).startOf('day');
    let day = DateTime.max(DateTime.fromJSDate(range.start, { zone }).startOf('day'), today);
    const last = DateTime.fromJSDate(new Date(range.end.getTime() - 1), { zone }).startOf('day');
    if (day > last) return [];
    const existing = await this.exceptions.listExceptions(actor.accountId, today.toISODate()!, '9999-12-31');
    const alreadyClosed = new Set(
      existing.filter((e) => e.kind === 'closed' && e.startLocal === null).map((e) => e.date),
    );
    const days: string[] = [];
    for (; day <= last; day = day.plus({ days: 1 })) {
      const iso = day.toISODate()!;
      if (!alreadyClosed.has(iso)) days.push(iso);
    }
    if (existing.length + days.length > MAX_EXCEPTIONS_PER_TEACHER)
      throw new AppError('LIMIT_EXCEEDED', 'Too many availability exceptions to close the period', {
        max: MAX_EXCEPTIONS_PER_TEACHER,
        needed: days.length,
        existing: existing.length,
      });
    return days;
  }

  // --- student and parent (UC-23) -------------------------------------------------------------

  /** `childId` is required for a parent (Р-25); a student passes nothing. */
  async previewPerson(
    actor: Actor,
    as: Exclude<CancelAs, 'TEACHER'>,
    selection: PersonSelection,
    childId?: string,
  ): Promise<BulkPreview> {
    assertActive(actor);
    const studentId = await this.studentOf(actor, as, childId);
    return this.assessPerson(as, studentId, await this.selectPerson(studentId, selection));
  }

  async executePerson(
    actor: Actor,
    as: Exclude<CancelAs, 'TEACHER'>,
    selection: PersonSelection,
    input: BulkReason,
    childId?: string,
  ): Promise<BulkResult> {
    assertActive(actor);
    const reason = normalizeCancelReason(input.reason);
    const now = this.clock.now();
    const studentId = await this.studentOf(actor, as, childId);
    return this.txm.run(async () => {
      const chosen = await this.selectPerson(studentId, selection);
      const locked = await this.lessons.lockByIds(chosen.map((l) => l.id));
      const preview = await this.assessPerson(as, studentId, locked);
      if (preview.items.length === 0) return { ...preview, cancellationId: null, closedDays: [] };
      const templateId = await this.single.ownTemplate(actor.accountId, input.templateId);
      const cancellation = await this.cancellations.insert({
        initiatorId: actor.accountId,
        initiatorRole: as,
        onBehalfOfStudentId: as === 'PARENT' ? studentId : null,
        kind: 'bulk',
        reason,
        templateId,
        createdAt: now,
      });
      const ctx: CancelContext = {
        cancellation,
        role: as,
        actorId: actor.accountId,
        source: actor.source,
        ip: actor.ip,
      };
      for (const item of preview.items) {
        if (item.outcome === 'absence')
          await this.single.absenceLocked(item.lesson, studentId, ctx, item.isLate, now);
        else await this.single.cancelLocked(item.lesson, ctx, item.isLate, now);
      }
      await this.publish(ctx, preview.items);
      return { ...preview, cancellationId: cancellation.id, closedDays: [] };
    });
  }

  private async studentOf(actor: Actor, as: Exclude<CancelAs, 'TEACHER'>, childId?: string): Promise<string> {
    if (!actor.roles.includes(as)) throw AppError.forbidden(`Not a ${as.toLowerCase()}`);
    if (as === 'STUDENT') return actor.accountId;
    if (!childId || !(await this.family.findActive(actor.accountId, childId)))
      throw AppError.notFound('child', childId);
    return childId;
  }

  /** Scheduled lessons the student takes part in, at teachers with an active link (8.0). */
  private async selectPerson(studentId: string, selection: PersonSelection): Promise<LessonRow[]> {
    let rows: LessonRow[];
    if ('lessonIds' in selection) {
      const ids = [...new Set(selection.lessonIds)].slice(0, MAX_BULK_LESSONS);
      const members = await this.lessons.listParticipantsOf(ids);
      rows = (await this.lessons.findByIds(ids)).filter((l) =>
        (members.get(l.id) ?? []).some((p) => p.studentId === studentId),
      );
    } else {
      assertRange(selection.range);
      rows = await this.lessons.listByStudent(studentId, selection.range, ['scheduled']);
      if (selection.teacherId) rows = rows.filter((l) => l.teacherId === selection.teacherId);
      assertBatchSize(rows);
    }
    const active = new Set((await this.links.listByStudent(studentId, ['active'])).map((l) => l.teacherId));
    return rows.filter((l) => active.has(l.teacherId));
  }

  private async assessPerson(
    as: Exclude<CancelAs, 'TEACHER'>,
    studentId: string,
    rows: LessonRow[],
  ): Promise<BulkPreview> {
    const now = this.clock.now();
    const profiles = new Map<string, TeacherProfileRow>();
    const members = await this.lessons.listParticipantsOf(rows.map((l) => l.id));
    const items: BulkItem[] = [];
    const excluded: ExcludedItem[] = [];
    for (const lesson of rows) {
      let profile = profiles.get(lesson.teacherId);
      if (!profile) profiles.set(lesson.teacherId, (profile = await this.profileOf(lesson.teacherId)));
      const me = (members.get(lesson.id) ?? []).find((p) => p.studentId === studentId);
      if (!me) {
        excluded.push({ lesson, code: 'NOT_PARTICIPANT' }); // removed from the lesson since the selection
        continue;
      }
      try {
        const check = checkCancel({ role: as, lesson, profile, now });
        if (check.outcome === 'absence' && me?.attendance === 'absent_notified')
          throw new AppError('CONFLICT', 'Absence is already reported', { reason: 'already_reported' });
        items.push({ lesson, studentIds: [studentId], ...check });
      } catch (error) {
        if (!AppError.is(error)) throw error;
        const cutoff = error.details?.['cutoffHours'];
        excluded.push({
          lesson,
          code: excludedCode(error),
          ...(typeof cutoff === 'number' ? { cutoffHours: cutoff } : {}),
        });
      }
    }
    return { items, excluded, lateCount: items.filter((i) => i.isLate).length };
  }

  // --- shared -------------------------------------------------------------------------------------

  private async profileOf(teacherId: string): Promise<TeacherProfileRow> {
    const profile = await this.profiles.find(teacherId);
    if (!profile) throw AppError.notFound('teacher profile', teacherId);
    return profile;
  }

  /** NTF-07: one summary per recipient is built by the notifications handler from this single event. */
  private publish(ctx: CancelContext, items: BulkItem[]): Promise<string> {
    return this.outbox.publish({
      type: 'cancellation.bulk',
      aggregateType: 'cancellation',
      aggregateId: ctx.cancellation.id,
      payload: {
        cancellationId: ctx.cancellation.id,
        byAccountId: ctx.actorId,
        byRole: ctx.role,
        onBehalfOfStudentId: ctx.cancellation.onBehalfOfStudentId,
        message: ctx.cancellation.reason,
        lessons: items.map((i) => ({
          lessonId: i.lesson.id,
          teacherId: i.lesson.teacherId,
          startsAt: i.lesson.startsAt.toISOString(),
          studentIds: i.studentIds,
          action: i.outcome === 'absence' ? 'absence' : 'cancelled',
          isLate: i.isLate,
        })),
      },
    });
  }
}
