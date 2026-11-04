import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { type Actor, assertRole, primaryRole } from '@modules/access/actor.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { GroupRepository } from '@modules/people/groups/group.repository.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { minutesToTime } from '../availability/windows.js';
import type { LessonTarget } from '../lessons/create-lesson.use-case.js';
import {
  type LessonDetailsInput,
  normalizeDuration,
  normalizeLessonDetails,
} from '../lessons/lesson.rules.js';
import type { LessonSeriesRow } from '../schema.js';
import { formatRRule, MAX_INTERVAL_WEEKS, parseRRule, phaseAlignedStart } from './rrule.js';
import { SeriesInstancesService } from './series-instances.service.js';
import { type MaterializationReport, SeriesMaterializer } from './series.materializer.js';
import { SeriesRepository } from './series.repository.js';

export interface CreateSeriesInput extends LessonDetailsInput {
  target: LessonTarget;
  weekdays: readonly number[];
  intervalWeeks?: number;
  startMin: number;
  durationMin: number;
  /** ISO date in the teacher's zone. */
  startsOn: string;
  endsOn?: string | null;
}

export interface SeriesChange {
  weekdays?: readonly number[];
  startMin?: number;
  durationMin?: number;
}

export interface CreatedSeries {
  series: LessonSeriesRow;
  report: MaterializationReport;
}

const isIsoDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && DateTime.fromISO(v).isValid;

/**
 * UC-15 / 5.5.6: regular lessons of a student or a group. Instances are materialised on creation and by the
 * worker (UC-39). A pause, an end or a split cancels the affected scheduled instances right here (time is freed,
 * `lesson.cancelled` per instance) and publishes `series.paused` / `series.ended` / `series.split` with their
 * ids; the cancellation messages to students are M4-06's job (T-18). "Это и последующие" splits the series:
 * the old one ends the day before, a new one starts on the date (same INTERVAL and week phase). "Только это" is
 * a reschedule of one instance and arrives with M4-03.
 */
@Injectable()
export class SeriesUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly series: SeriesRepository,
    private readonly materializer: SeriesMaterializer,
    private readonly instances: SeriesInstancesService,
    private readonly links: TeacherStudentRepository,
    private readonly groups: GroupRepository,
    private readonly accounts: AccountRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  async create(actor: Actor, input: CreateSeriesInput): Promise<CreatedSeries> {
    assertRole(actor, 'TEACHER');
    const rrule = this.rruleOf(input.weekdays, input.intervalWeeks ?? 1);
    const durationMin = normalizeDuration(input.durationMin);
    if (!Number.isInteger(input.startMin) || input.startMin < 0 || input.startMin >= 24 * 60)
      throw AppError.validation('startMin is out of range');
    if (!isIsoDate(input.startsOn) || (input.endsOn && !isIsoDate(input.endsOn)))
      throw AppError.validation('Series dates must be ISO dates');
    if (input.endsOn && input.endsOn < input.startsOn) throw AppError.validation('endsOn is before startsOn');
    const details = normalizeLessonDetails(input);
    const teacher = await this.accounts.findById(actor.accountId);
    if (!teacher) throw AppError.notFound('teacher', actor.accountId);
    const today = DateTime.fromJSDate(this.clock.now(), { zone: teacher.timezone }).toISODate()!;
    if (input.endsOn && input.endsOn < today)
      throw AppError.validation('The series would end in the past', { reason: 'past' });
    return this.txm.run(async () => {
      await this.assertTarget(actor.accountId, input.target);
      const series = await this.series.insert({
        teacherId: actor.accountId,
        studentId: 'studentId' in input.target ? input.target.studentId : null,
        groupId: 'groupId' in input.target ? input.target.groupId : null,
        rrule,
        startLocal: minutesToTime(input.startMin),
        durationMin,
        timezone: teacher.timezone,
        startsOn: input.startsOn,
        endsOn: input.endsOn ?? null,
        subjectId: details.subjectId ?? null,
        format: details.format ?? null,
        location: details.location ?? null,
        meetingUrl: details.meetingUrl ?? null,
      });
      await this.record(actor, 'series.created', series.id, {
        rrule,
        startLocal: series.startLocal,
        durationMin,
        startsOn: series.startsOn,
        endsOn: series.endsOn,
      });
      const report = await this.materializer.materialize(series);
      await this.outbox.publish({
        type: 'series.created',
        aggregateType: 'lesson_series',
        aggregateId: series.id,
        payload: {
          seriesId: series.id,
          teacherId: actor.accountId,
          studentIds: await this.studentIdsOf(input.target),
          weekdays: parseRRule(rrule).weekdays,
          startLocal: series.startLocal,
          durationMin,
          subjectId: series.subjectId,
        },
      });
      return { series: (await this.series.findById(series.id))!, report };
    });
  }

  /** One pause window per series (a new pause replaces it); its instances are cancelled, new ones not created. */
  async pause(actor: Actor, seriesId: string, from: string, to: string): Promise<LessonSeriesRow> {
    assertRole(actor, 'TEACHER');
    if (!isIsoDate(from) || !isIsoDate(to) || to < from) throw AppError.validation('Pause dates are invalid');
    return this.txm.run(async () => {
      const series = await this.own(actor, seriesId);
      const updated = await this.series.update(series.id, { pausedFrom: from, pausedTo: to });
      const zone = series.timezone;
      const now = this.clock.now();
      const lessonIds = await this.instances.cancel(
        series.id,
        DateTime.fromISO(from, { zone }).startOf('day').toJSDate(),
        DateTime.fromISO(to, { zone }).plus({ days: 1 }).startOf('day').toJSDate(),
        'series_paused',
        now,
        actor.accountId,
      );
      await this.record(actor, 'series.paused', series.id, { from, to, lessons: lessonIds.length });
      await this.outbox.publish({
        type: 'series.paused',
        aggregateType: 'lesson_series',
        aggregateId: series.id,
        payload: { seriesId: series.id, teacherId: actor.accountId, from, to, lessonIds },
      });
      return updated;
    });
  }

  async resume(actor: Actor, seriesId: string): Promise<LessonSeriesRow> {
    assertRole(actor, 'TEACHER');
    return this.txm.run(async () => {
      const series = await this.own(actor, seriesId);
      if (!series.pausedFrom) return series;
      const updated = await this.series.update(series.id, {
        pausedFrom: null,
        pausedTo: null,
        materializedUntil: null,
      });
      await this.record(actor, 'series.resumed', series.id, {});
      await this.materializer.materialize(updated); // fills the gap the pause left, up to the horizon
      return (await this.series.findById(series.id))!;
    });
  }

  /** Ends the series on `fromDate` (exclusive): future instances are reported for cancellation (M4-06). */
  async end(actor: Actor, seriesId: string, fromDate: string): Promise<LessonSeriesRow> {
    assertRole(actor, 'TEACHER');
    if (!isIsoDate(fromDate)) throw AppError.validation('fromDate must be an ISO date');
    return this.txm.run(async () => {
      const series = await this.own(actor, seriesId);
      return this.endLocked(actor, series, fromDate, 'series.ended');
    });
  }

  /** "Это и последующие": the series is split on the date; the new part carries the changed fields. */
  async changeFollowing(
    actor: Actor,
    seriesId: string,
    fromDate: string,
    change: SeriesChange,
  ): Promise<{ ended: LessonSeriesRow; next: LessonSeriesRow; report: MaterializationReport }> {
    assertRole(actor, 'TEACHER');
    if (!isIsoDate(fromDate)) throw AppError.validation('fromDate must be an ISO date');
    const badStart =
      change.startMin !== undefined &&
      (!Number.isInteger(change.startMin) || change.startMin < 0 || change.startMin >= 24 * 60);
    if (badStart) throw AppError.validation('startMin is out of range');
    return this.txm.run(async () => {
      const series = await this.own(actor, seriesId);
      const today = DateTime.fromJSDate(this.clock.now(), { zone: series.timezone }).toISODate()!;
      if (fromDate < today || fromDate < series.startsOn)
        throw AppError.validation('The change must start today or later, within the series', {
          reason: 'past',
        });
      if (series.endsOn && series.endsOn < fromDate)
        throw AppError.validation('The series already ends before this date');
      const ended = await this.endLocked(actor, series, fromDate, 'series.split');
      const { intervalWeeks } = parseRRule(series.rrule);
      const rrule = change.weekdays ? this.rruleOf(change.weekdays, intervalWeeks) : series.rrule;
      const next = await this.series.insert({
        teacherId: series.teacherId,
        studentId: series.studentId,
        groupId: series.groupId,
        rrule,
        startLocal: change.startMin !== undefined ? minutesToTime(change.startMin) : series.startLocal,
        durationMin:
          change.durationMin !== undefined ? normalizeDuration(change.durationMin) : series.durationMin,
        timezone: series.timezone,
        // the tail keeps the week phase of a biweekly series (INTERVAL counts from the anchor week)
        startsOn: phaseAlignedStart(series.startsOn, intervalWeeks, fromDate, series.timezone),
        endsOn: series.endsOn,
        pausedFrom: series.pausedFrom,
        pausedTo: series.pausedTo,
        subjectId: series.subjectId,
        format: series.format,
        location: series.location,
        meetingUrl: series.meetingUrl,
      });
      await this.record(actor, 'series.created', next.id, {
        splitFrom: series.id,
        rrule,
        startLocal: next.startLocal,
        durationMin: next.durationMin,
      });
      const report = await this.materializer.materialize(next);
      return { ended, next: (await this.series.findById(next.id))!, report };
    });
  }

  async listActive(actor: Actor): Promise<LessonSeriesRow[]> {
    assertRole(actor, 'TEACHER');
    return this.series.listActiveByTeacher(actor.accountId);
  }

  async get(actor: Actor, seriesId: string): Promise<LessonSeriesRow> {
    assertRole(actor, 'TEACHER');
    const series = await this.series.findById(seriesId);
    if (!series || series.teacherId !== actor.accountId) throw AppError.notFound('series', seriesId);
    return series;
  }

  /** 5.7.6: the system ends a series (blocked teacher or student); instances already cancelled are skipped. */
  async endBySystem(seriesId: string, byAccountId: string | null): Promise<void> {
    await this.txm.run(async () => {
      const series = await this.series.findById(seriesId, { forUpdate: true });
      if (!series || series.status !== 'active') return;
      const today = DateTime.fromJSDate(this.clock.now(), { zone: series.timezone }).toISODate()!;
      const actor: Actor = {
        accountId: byAccountId ?? series.teacherId,
        roles: ['SUPER_ADMIN'],
        status: 'active',
        source: 'system',
      };
      await this.endLocked(actor, series, today, 'series.ended');
    });
  }

  /** Ends on `fromDate` (exclusive) and cancels the scheduled instances from that day on. */
  private async endLocked(
    actor: Actor,
    series: LessonSeriesRow,
    fromDate: string,
    eventType: 'series.ended' | 'series.split',
  ): Promise<LessonSeriesRow> {
    const zone = series.timezone;
    const lastDay = DateTime.fromISO(fromDate, { zone }).minus({ days: 1 }).toISODate()!;
    const endsOn = lastDay < series.startsOn ? series.startsOn : lastDay;
    const updated = await this.series.update(series.id, {
      status: 'ended',
      endsOn,
      ...(series.materializedUntil && series.materializedUntil > endsOn ? { materializedUntil: endsOn } : {}),
    });
    const lessonIds = await this.instances.cancel(
      series.id,
      DateTime.fromISO(fromDate, { zone }).startOf('day').toJSDate(),
      undefined,
      eventType === 'series.split' ? 'series_changed' : 'series_ended',
      this.clock.now(),
      actor.accountId,
    );
    await this.record(actor, eventType, series.id, { fromDate, lessons: lessonIds.length });
    await this.outbox.publish({
      type: eventType,
      aggregateType: 'lesson_series',
      aggregateId: series.id,
      payload: { seriesId: series.id, teacherId: series.teacherId, fromDate, lessonIds },
    });
    return updated;
  }

  /** The teacher's own active series, locked (8.0). */
  private async own(actor: Actor, seriesId: string): Promise<LessonSeriesRow> {
    const series = await this.series.findById(seriesId, { forUpdate: true });
    if (!series || series.teacherId !== actor.accountId) throw AppError.notFound('series', seriesId);
    if (series.status !== 'active')
      throw new AppError('CONFLICT', 'Series is already ended', { reason: 'ended' });
    return series;
  }

  private async assertTarget(teacherId: string, target: LessonTarget): Promise<void> {
    if ('studentId' in target) {
      const link = await this.links.findByPair(teacherId, target.studentId);
      if (link?.status !== 'active')
        throw new AppError('LINK_NOT_ACTIVE', 'The student is not an active student of this teacher');
      return;
    }
    const group = await this.groups.findById(target.groupId);
    if (!group || group.teacherId !== teacherId) throw AppError.notFound('group', target.groupId);
    if (group.archivedAt) throw new AppError('CONFLICT', 'Group is archived', { reason: 'archived' });
  }

  private async studentIdsOf(target: LessonTarget): Promise<string[]> {
    if ('studentId' in target) return [target.studentId];
    return (await this.groups.listMembers(target.groupId)).map((m) => m.studentId);
  }

  private rruleOf(weekdays: readonly number[], intervalWeeks: number): string {
    const days = [...new Set(weekdays)];
    if (days.length === 0 || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7))
      throw AppError.validation('Choose at least one weekday (1–7)');
    if (!Number.isInteger(intervalWeeks) || intervalWeeks < 1 || intervalWeeks > MAX_INTERVAL_WEEKS)
      throw AppError.validation('intervalWeeks is out of range', { max: MAX_INTERVAL_WEEKS });
    return formatRRule({ intervalWeeks, weekdays: days });
  }

  private record(
    actor: Actor,
    action: string,
    seriesId: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record({
      actorId: actor.accountId,
      actorRole: primaryRole(actor),
      action,
      entityType: 'lesson_series',
      entityId: seriesId,
      after,
      source: actor.source,
      ip: actor.ip,
    });
  }
}
