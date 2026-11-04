import { Inject, Injectable, Logger } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { Clock, DAY_MS } from '@shared/time/clock.js';
import { FeatureService } from '@modules/access/features/feature.service.js';
import { LessonsQuery } from '@modules/schedule/lessons/lessons.query.js';
import { ExternalBusyRepository } from '@modules/schedule/occupancy/external-busy.repository.js';
import type { Interval } from '@modules/schedule/schema.js';
import type { GoogleConnectionRow } from '../schema.js';
import { GOOGLE_API, type GoogleApi, GoogleAuthError } from './google-api.js';
import { type ConnectionPatch, GoogleCalendarRepository } from './google-calendar.repository.js';
import { GoogleCalendarUseCase } from './google-calendar.use-case.js';
import { EXPORT_AHEAD_DAYS, EXPORT_PAST_DAYS, EXPORTED_STATUSES, planExport } from './google-export.rules.js';

/** Busy time is read a day back and two months ahead: the booking horizon of 5.5.5 fits inside. */
export const IMPORT_PAST_DAYS = 1;
export const IMPORT_AHEAD_DAYS = 62;

export interface SyncReport {
  connectionId: string;
  skipped: 'locked' | 'feature_off' | 'not_active' | null;
  imported: number;
  exported: { inserted: number; updated: number; deleted: number };
  error: string | null;
}

interface MappingWrite {
  lessonId: string;
  googleEventId: string;
  signature: string;
}

/**
 * One sync of a connection (5.14.1): freebusy of the chosen calendars → `external_busy` (5.5.2 soft block), then
 * the lessons of the window → the app calendar (insert / update / delete by the export plan). The transaction
 * holds only the advisory lock of the connection while Google is called — no row locks, so lesson events, the
 * bot and a disconnect are never blocked by a slow export; the results are written at the end, after re-checking
 * that the connection is still live. A paused feature clears the imported busy time and skips (5.3.3). Google
 * being unavailable leaves the previous state in place (10.5 «мягкая деградация»); a revoked grant parks the
 * connection in `error` and tells the teacher once.
 */
@Injectable()
export class GoogleSyncService {
  private readonly logger = new Logger(GoogleSyncService.name);

  constructor(
    private readonly txm: TransactionManager,
    private readonly repo: GoogleCalendarRepository,
    private readonly useCase: GoogleCalendarUseCase,
    private readonly lessons: LessonsQuery,
    private readonly externalBusy: ExternalBusyRepository,
    private readonly features: FeatureService,
    private readonly clock: Clock,
    @Inject(GOOGLE_API) private readonly google: GoogleApi,
  ) {}

  async sync(connectionId: string): Promise<SyncReport> {
    const report: SyncReport = {
      connectionId,
      skipped: null,
      imported: 0,
      exported: { inserted: 0, updated: 0, deleted: 0 },
      error: null,
    };
    return this.txm.run(async () => {
      if (!(await this.repo.lockConnection(connectionId))) return { ...report, skipped: 'locked' };
      const row = await this.repo.findById(connectionId);
      if (!row || !isLive(row)) return { ...report, skipped: 'not_active' };
      if (!(await this.features.isEnabled(row.accountId, 'calendar.google'))) {
        await this.externalBusy.clear(row.accountId, 'google');
        return { ...report, skipped: 'feature_off' };
      }
      const now = this.clock.now();
      const patch: ConnectionPatch = {};
      try {
        const token = await this.useCase.accessTokenOf(row);
        Object.assign(patch, token.refreshed ?? {});
        // --- Google, with nothing locked but the advisory lock ---
        const busy = row.importEnabled ? await this.importBusy(row, token.accessToken, now) : null;
        const exported = await this.exportLessons(row, token.accessToken, now);
        // --- writes, only if nobody disconnected meanwhile ---
        const fresh = await this.repo.findById(row.id);
        if (!fresh || !isLive(fresh)) return { ...report, skipped: 'not_active' };
        if (busy) report.imported = await this.externalBusy.replace(row.accountId, 'google', busy, now);
        for (const m of exported.upserts)
          await this.repo.upsertMapping({ connectionId: row.id, ...m, at: now });
        await this.repo.markMappingDeleted(row.id, exported.deleted, now);
        report.exported = exported.counts;
        await this.repo.update(row.id, { ...patch, lastImportAt: now, lastExportAt: now, lastError: null });
      } catch (error) {
        if (error instanceof GoogleAuthError) {
          await this.useCase.markAuthFailed(row, error);
          report.error = `auth: ${error.message}`;
        } else {
          const message = error instanceof Error ? error.message : String(error);
          await this.repo.update(row.id, { ...patch, lastError: message.slice(0, 500) });
          report.error = message;
          this.logger.warn({ err: error, connection: row.id }, 'google sync failed; will retry');
        }
      }
      return report;
    });
  }

  private async importBusy(row: GoogleConnectionRow, accessToken: string, now: Date): Promise<Interval[]> {
    return this.google.freeBusy(accessToken, row.busyCalendarIds, {
      start: new Date(now.getTime() - IMPORT_PAST_DAYS * DAY_MS),
      end: new Date(now.getTime() + IMPORT_AHEAD_DAYS * DAY_MS),
    });
  }

  private async exportLessons(
    row: GoogleConnectionRow,
    accessToken: string,
    now: Date,
  ): Promise<{ upserts: MappingWrite[]; deleted: string[]; counts: SyncReport['exported'] }> {
    const result = {
      upserts: [] as MappingWrite[],
      deleted: [] as string[],
      counts: { inserted: 0, updated: 0, deleted: 0 },
    };
    const calendarId = row.calendarId;
    if (!calendarId) return result;
    const mappings = (await this.repo.listMappings(row.id)).map((m) => ({
      lessonId: m.lessonId,
      googleEventId: m.googleEventId,
      signature: m.signature,
      deleted: m.deletedAt !== null,
    }));
    const live = row.exportEnabled
      ? await this.lessons.teacherLessons(
          row.accountId,
          {
            start: new Date(now.getTime() - EXPORT_PAST_DAYS * DAY_MS),
            end: new Date(now.getTime() + EXPORT_AHEAD_DAYS * DAY_MS),
          },
          EXPORTED_STATUSES,
        )
      : [];
    // mapped lessons outside the window (or with the export off): gone only when cancelled / not held / missing
    const liveIds = new Set(live.map((v) => v.lesson.id));
    const outside = mappings.filter((m) => !m.deleted && !liveIds.has(m.lessonId)).map((m) => m.lessonId);
    const kept = new Set(
      (await this.lessons.teacherLessonsByIds(row.accountId, outside))
        .filter((v) => row.exportEnabled && EXPORTED_STATUSES.includes(v.lesson.status))
        .map((v) => v.lesson.id),
    );
    for (const op of planExport(row.id, live, mappings, (lessonId) => !kept.has(lessonId))) {
      if (op.op === 'insert') {
        await this.google.insertEvent(accessToken, calendarId, op.googleEventId, op.event);
        result.upserts.push({
          lessonId: op.lessonId,
          googleEventId: op.googleEventId,
          signature: op.signature,
        });
        result.counts.inserted += 1;
      } else if (op.op === 'update') {
        await this.google.updateEvent(accessToken, calendarId, op.googleEventId, op.event);
        result.upserts.push({
          lessonId: op.lessonId,
          googleEventId: op.googleEventId,
          signature: op.signature,
        });
        result.counts.updated += 1;
      } else {
        await this.google.deleteEvent(accessToken, calendarId, op.googleEventId);
        result.deleted.push(op.lessonId);
        result.counts.deleted += 1;
      }
    }
    return result;
  }
}

function isLive(row: GoogleConnectionRow): boolean {
  return row.revokedAt === null && row.status === 'active';
}
