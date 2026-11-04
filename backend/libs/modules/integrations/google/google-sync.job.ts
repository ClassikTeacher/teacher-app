import { Injectable, Logger } from '@nestjs/common';
import { Clock, MINUTE_MS } from '@shared/time/clock.js';
import { GoogleCalendarRepository } from './google-calendar.repository.js';
import { GoogleSyncService, type SyncReport } from './google-sync.service.js';

/** 5.14.1 💡 «раз в 10 минут»: the periodic import; exports requested by lesson events run on the next tick. */
export const GOOGLE_SYNC_INTERVAL_MS = 10 * MINUTE_MS;
const BATCH = 50;

/** Runs from the worker every minute and syncs the connections that are due (see GoogleCalendarRepository.listDue). */
@Injectable()
export class GoogleSyncJob {
  private readonly logger = new Logger(GoogleSyncJob.name);

  constructor(
    private readonly repo: GoogleCalendarRepository,
    private readonly sync: GoogleSyncService,
    private readonly clock: Clock,
  ) {}

  async run(): Promise<SyncReport[]> {
    const due = await this.repo.listDue(this.clock.now(), GOOGLE_SYNC_INTERVAL_MS, BATCH);
    const reports: SyncReport[] = [];
    for (const row of due) {
      const report = await this.sync.sync(row.id);
      reports.push(report);
    }
    const failed = reports.filter((r) => r.error).length;
    if (reports.length > 0)
      this.logger.debug({ count: reports.length, failed }, 'google calendar connections synced');
    return reports;
  }
}
