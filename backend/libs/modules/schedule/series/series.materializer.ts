import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import type { Actor } from '@modules/access/actor.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { CreateLessonUseCase } from '../lessons/create-lesson.use-case.js';
import type { LessonSeriesRow } from '../schema.js';
import { expandSeries, type Occurrence } from './rrule.js';
import { SeriesInstancesService } from './series-instances.service.js';
import { SeriesRepository } from './series.repository.js';

/** 5.5.6 "скользящий горизонт" (💡 12 недель). */
export const MATERIALIZATION_HORIZON_WEEKS = 12;
const BATCH = 50;

export interface MaterializationReport {
  created: number;
  conflicts: Occurrence[];
  /** The series was ended because its student or group is gone (link ended, group archived or empty). */
  ended: boolean;
}

/** Instances are created on behalf of the teacher; audit rows carry `source: system`. */
export function seriesActor(teacherId: string): Actor {
  return { accountId: teacherId, roles: ['TEACHER'], status: 'active', source: 'system' };
}

/**
 * Creates the lesson instances of a series up to the horizon (UC-39): every occurrence goes through
 * CreateLessonUseCase in its own savepoint, so a conflict (CAL-01) skips that instance and is reported to the
 * teacher; the series remembers `materialized_until`, so a re-run never creates duplicates.
 */
@Injectable()
export class SeriesMaterializer {
  private readonly logger = new Logger(SeriesMaterializer.name);

  constructor(
    private readonly txm: TransactionManager,
    private readonly series: SeriesRepository,
    private readonly createLesson: CreateLessonUseCase,
    private readonly instances: SeriesInstancesService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  horizonDate(zone: string): string {
    return DateTime.fromJSDate(this.clock.now(), { zone })
      .plus({ weeks: MATERIALIZATION_HORIZON_WEEKS })
      .toISODate()!;
  }

  /** Expands one (locked) series inside the current transaction and publishes the report when needed. */
  async materialize(series: LessonSeriesRow): Promise<MaterializationReport> {
    const today = DateTime.fromJSDate(this.clock.now(), { zone: series.timezone }).toISODate()!;
    const fromDate = series.materializedUntil
      ? DateTime.fromISO(series.materializedUntil).plus({ days: 1 }).toISODate()!
      : series.startsOn;
    const toDate = this.horizonDate(series.timezone);
    const report: MaterializationReport = { created: 0, conflicts: [], ended: false };
    if (fromDate > toDate) return report;
    const occurrences = expandSeries({
      rrule: series.rrule,
      zone: series.timezone,
      startMin: timeOf(series.startLocal),
      durationMin: series.durationMin,
      startsOn: series.startsOn,
      endsOn: series.endsOn,
      fromDate: fromDate < today ? today : fromDate,
      toDate,
      pausedFrom: series.pausedFrom,
      pausedTo: series.pausedTo,
    });
    const actor = seriesActor(series.teacherId);
    const existing = await this.series.instanceStarts(series.id); // a resume or a re-run never duplicates
    for (const occurrence of occurrences) {
      if (existing.has(occurrence.during.start.getTime())) continue;
      try {
        await this.txm.runSavepoint(() =>
          this.createLesson.execute(actor, {
            target: series.studentId ? { studentId: series.studentId } : { groupId: series.groupId! },
            startsAt: occurrence.during.start,
            durationMin: series.durationMin,
            subjectId: series.subjectId,
            format: series.format,
            location: series.location,
            meetingUrl: series.meetingUrl,
            createdVia: 'series',
            seriesId: series.id,
          }),
        );
        report.created += 1;
      } catch (error) {
        if (AppError.is(error, 'LESSON_CONFLICT')) {
          report.conflicts.push(occurrence);
          continue;
        }
        if (AppError.is(error, 'VALIDATION_ERROR') && error.details?.['reason'] === 'past') continue;
        if (isTargetGone(error)) {
          report.ended = true;
          break;
        }
        throw error;
      }
    }
    const endsOn = today < series.startsOn ? series.startsOn : today;
    await this.series.update(series.id, {
      materializedUntil: report.ended ? endsOn : toDate,
      ...(report.ended ? { status: 'ended', endsOn } : {}),
    });
    if (report.ended) {
      // the student or group is gone: already created future instances are freed (M4-06 tells people)
      const now = this.clock.now();
      const lessonIds = await this.instances.cancel(series.id, now, undefined, 'series_ended', now);
      await this.outbox.publish({
        type: 'series.ended',
        aggregateType: 'lesson_series',
        aggregateId: series.id,
        payload: {
          seriesId: series.id,
          teacherId: series.teacherId,
          fromDate: endsOn,
          lessonIds,
          reason: 'target_gone',
        },
      });
    }
    if (report.conflicts.length > 0 || report.ended) {
      await this.outbox.publish({
        type: 'series.materialized',
        aggregateType: 'lesson_series',
        aggregateId: series.id,
        payload: {
          seriesId: series.id,
          teacherId: series.teacherId,
          created: report.created,
          ended: report.ended,
          conflicts: report.conflicts.map((c) => c.during.start.toISOString()),
        },
      });
    }
    return report;
  }

  /**
   * One worker pass: every series whose horizon lags behind, one series per transaction so a broken series
   * (bad rule, database error) is logged and skipped instead of rolling back the others. The due predicate uses
   * the UTC date with a day of slack; `materialize` itself works in the teacher's zone.
   */
  async run(): Promise<number> {
    const nowIso = this.clock.now().toISOString().slice(0, 10);
    const horizon = DateTime.fromISO(nowIso)
      .plus({ weeks: MATERIALIZATION_HORIZON_WEEKS, days: -1 })
      .toISODate()!;
    const failed = new Set<string>();
    let processed = 0;
    for (;;) {
      const due = await this.series.lockDueForMaterialization(horizon, BATCH);
      const pending = due.filter((s) => !failed.has(s.id));
      if (pending.length === 0) return processed;
      for (const candidate of pending) {
        try {
          await this.txm.run(async () => {
            const series = await this.series.findById(candidate.id, { forUpdate: true });
            if (!series || series.status !== 'active') return;
            const report = await this.materialize(series);
            this.logger.debug(
              { seriesId: series.id, created: report.created, conflicts: report.conflicts.length },
              'series materialized',
            );
          });
          processed += 1;
        } catch (error) {
          failed.add(candidate.id);
          this.logger.error({ err: error, seriesId: candidate.id }, 'series materialization failed; skipped');
        }
      }
      if (due.length < BATCH) return processed;
    }
  }
}

/** Only a vanished target ends a series; any other failure is a bug or an outage and must surface. */
function isTargetGone(error: unknown): boolean {
  if (AppError.is(error, 'LINK_NOT_ACTIVE')) return true;
  if (AppError.is(error, 'ACCOUNT_BLOCKED')) return true; // a blocked teacher: the series ends (H-1)
  if (AppError.is(error, 'NOT_FOUND')) return error.details?.['entity'] === 'group';
  if (AppError.is(error, 'CONFLICT')) return error.details?.['reason'] === 'archived';
  if (AppError.is(error, 'VALIDATION_ERROR')) return error.details?.['reason'] === 'empty_group';
  return false;
}

function timeOf(value: string): number {
  const [h = '0', m = '0'] = value.split(':');
  return Number(h) * 60 + Number(m);
}
