import { Inject, Injectable, Logger } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { Clock, DAY_MS } from '@shared/time/clock.js';
import { FeatureService } from '@modules/access/features/feature.service.js';
import { LessonsQuery } from '@modules/schedule/lessons/lessons.query.js';
import { ExternalBusyRepository } from '@modules/schedule/occupancy/external-busy.repository.js';
import type { GoogleConnectionRow } from '../schema.js';
import { GOOGLE_API, type GoogleApi, GoogleAuthError } from './google-api.js';
import { GoogleCalendarRepository } from './google-calendar.repository.js';
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

/**
 * One sync of a connection (5.14.1): freebusy of the chosen calendars → `external_busy` (5.5.2 soft block), then
 * the lessons of the window → the app calendar (insert / update / delete by the export plan). Runs under an
 * advisory lock per connection; a paused feature clears the imported busy time and skips (5.3.3). Google being
 * unavailable leaves the previous state in place (10.5 «мягкая деградация»); revoked access parks the connection
 * in `error` and tells the teacher once.
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
      if (!row || row.revokedAt || row.status !== 'active') return { ...report, skipped: 'not_active' };
      if (!(await this.features.isEnabled(row.accountId, 'calendar.google'))) {
        await this.externalBusy.clear(row.accountId, 'google');
        return { ...report, skipped: 'feature_off' };
      }
      const now = this.clock.now();
      try {
        const accessToken = await this.useCase.accessTokenOf(row);
        report.imported = await this.importBusy(row, accessToken, now);
        report.exported = await this.exportLessons(row, accessToken, now);
        if (row.lastError) await this.repo.update(row.id, { lastError: null });
      } catch (error) {
        if (error instanceof GoogleAuthError) {
          await this.useCase.markAuthFailed(row, error);
          report.error = `auth: ${error.message}`;
        } else {
          const message = error instanceof Error ? error.message : String(error);
          await this.repo.update(row.id, { lastError: message.slice(0, 500) });
          report.error = message;
          this.logger.warn({ err: error, connection: row.id }, 'google sync failed; will retry');
        }
      }
      return report;
    });
  }

  private async importBusy(row: GoogleConnectionRow, accessToken: string, now: Date): Promise<number> {
    if (!row.importEnabled) {
      await this.repo.update(row.id, { lastImportAt: now });
      return 0;
    }
    const range = {
      start: new Date(now.getTime() - IMPORT_PAST_DAYS * DAY_MS),
      end: new Date(now.getTime() + IMPORT_AHEAD_DAYS * DAY_MS),
    };
    const busy = await this.google.freeBusy(accessToken, row.busyCalendarIds, range);
    const count = await this.externalBusy.replace(row.accountId, 'google', busy, now);
    await this.repo.update(row.id, { lastImportAt: now });
    return count;
  }

  private async exportLessons(
    row: GoogleConnectionRow,
    accessToken: string,
    now: Date,
  ): Promise<SyncReport['exported']> {
    const result = { inserted: 0, updated: 0, deleted: 0 };
    const mappings = (await this.repo.listMappings(row.id)).map((m) => ({
      lessonId: m.lessonId,
      googleEventId: m.googleEventId,
      signature: m.signature,
      deleted: m.deletedAt !== null,
    }));
    const live =
      row.exportEnabled && row.calendarId
        ? await this.lessons.teacherLessons(
            row.accountId,
            {
              start: new Date(now.getTime() - EXPORT_PAST_DAYS * DAY_MS),
              end: new Date(now.getTime() + EXPORT_AHEAD_DAYS * DAY_MS),
            },
            EXPORTED_STATUSES,
          )
        : [];
    const api = this.google;
    const calendarId = row.calendarId;
    for (const op of planExport(live, mappings)) {
      if (!calendarId) break;
      if (op.op === 'insert') {
        const id = await api.insertEvent(accessToken, calendarId, op.event);
        await this.repo.upsertMapping({
          connectionId: row.id,
          lessonId: op.lessonId,
          googleEventId: id,
          signature: op.signature,
          at: now,
        });
        result.inserted += 1;
      } else if (op.op === 'update') {
        await api.updateEvent(accessToken, calendarId, op.googleEventId, op.event);
        await this.repo.upsertMapping({
          connectionId: row.id,
          lessonId: op.lessonId,
          googleEventId: op.googleEventId,
          signature: op.signature,
          at: now,
        });
        result.updated += 1;
      } else {
        await api.deleteEvent(accessToken, calendarId, op.googleEventId);
        await this.repo.markMappingDeleted(row.id, [op.lessonId], now);
        result.deleted += 1;
      }
    }
    await this.repo.update(row.id, { lastExportAt: now });
    return result;
  }
}
