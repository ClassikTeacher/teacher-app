import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { BOT_KINDS } from '@shared/config/env.schema.js';
import { OverdueAssignmentsJob } from '@modules/homework/overdue.job.js';
import { FileMaintenanceJob } from '@modules/files/file-maintenance.job.js';
import { GoogleSyncJob } from '@modules/integrations/google/google-sync.job.js';
import { ExpireInvitationsJob } from '@modules/identity/expire-invitations.job.js';
import { ExpireLeaveRequestsJob } from '@modules/people/links/expire-leave-requests.job.js';
import { DailyDigestJob } from '@modules/notifications/digest.job.js';
import { NotificationScheduler } from '@modules/notifications/notification.scheduler.js';
import { NotificationSender } from '@modules/notifications/notification.sender.js';
import { OutboxConsumer } from '@modules/outbox/outbox.consumer.js';
import { OutboxPublisher } from '@modules/outbox/outbox.publisher.js';
import { LessonLifecycleJob } from '@modules/schedule/lessons/lesson-lifecycle.job.js';
import { RescheduleRequestUseCase } from '@modules/schedule/reschedule/reschedule-request.use-case.js';
import { SeriesMaterializer } from '@modules/schedule/series/series.materializer.js';

const OUTBOX_INTERVAL_MS = 2_000;
const SCHEDULER_INTERVAL_MS = 30_000;
const EXPIRY_INTERVAL_MS = 10 * 60_000;
/** UC-39: the rolling 12-week horizon of series moves once an hour. */
const SERIES_INTERVAL_MS = 60 * 60_000;
/** LES-01: lessons become `awaiting_report` within a minute of their end. */
const LESSON_LIFECYCLE_INTERVAL_MS = 60_000;
/** 5.5.5 item 5: requests expire with the minimum notice; a few minutes of lag is fine. */
const REQUEST_EXPIRY_INTERVAL_MS = 5 * 60_000;
/** 5.5.7: the morning digest goes out within a few minutes of the chosen time. */
const DIGEST_INTERVAL_MS = 5 * 60_000;
/** HW-06 / 10.4: orphan draft files and deferred antivirus checks are swept every 15 minutes. */
const FILES_INTERVAL_MS = 15 * 60_000;
/** UC-40: a passed due date is noticed within a few minutes. */
const HOMEWORK_INTERVAL_MS = 5 * 60_000;
/** 5.14.1: Google connections are checked every minute; each syncs when due (requested export or 10 minutes). */
const GOOGLE_INTERVAL_MS = 60_000;

/**
 * Starts the periodic jobs and the queue workers (7.4 "worker"). Ticks never overlap with themselves and are
 * awaited on shutdown before queues and connections are closed (module destroy runs before application shutdown).
 */
@Injectable()
export class WorkerRunner implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerRunner.name);
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private stopping = false;

  constructor(
    private readonly outboxPublisher: OutboxPublisher,
    private readonly outboxConsumer: OutboxConsumer,
    private readonly scheduler: NotificationScheduler,
    private readonly sender: NotificationSender,
    private readonly expireInvitations: ExpireInvitationsJob,
    private readonly expireLeaveRequests: ExpireLeaveRequestsJob,
    private readonly seriesMaterializer: SeriesMaterializer,
    private readonly lessonLifecycle: LessonLifecycleJob,
    private readonly requests: RescheduleRequestUseCase,
    private readonly digest: DailyDigestJob,
    private readonly fileMaintenance: FileMaintenanceJob,
    private readonly overdue: OverdueAssignmentsJob,
    private readonly googleSync: GoogleSyncJob,
  ) {}

  onModuleInit(): void {
    this.outboxConsumer.start();
    const bots = this.sender.start(BOT_KINDS);
    this.every('outbox', OUTBOX_INTERVAL_MS, () => this.outboxPublisher.publishPending());
    this.every('notifications', SCHEDULER_INTERVAL_MS, () => this.scheduler.tick());
    this.every('invitations', EXPIRY_INTERVAL_MS, () => this.expireInvitations.run());
    this.every('leave-requests', EXPIRY_INTERVAL_MS, () => this.expireLeaveRequests.run());
    this.every('series', SERIES_INTERVAL_MS, () => this.seriesMaterializer.run());
    this.every('lessons', LESSON_LIFECYCLE_INTERVAL_MS, () => this.lessonLifecycle.run());
    this.every('requests', REQUEST_EXPIRY_INTERVAL_MS, () => this.requests.expire());
    this.every('digest', DIGEST_INTERVAL_MS, () => this.digest.run());
    this.every('files', FILES_INTERVAL_MS, () => this.fileMaintenance.run());
    this.every('homework', HOMEWORK_INTERVAL_MS, () => this.overdue.run());
    this.every('google', GOOGLE_INTERVAL_MS, () => this.googleSync.run());
    this.logger.log(
      `jobs started: outbox, notifications, invitations, leave-requests, series, lessons, requests, digest, files, homework, google; send workers: ${bots.join(', ') || 'none'}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers) clearInterval(timer);
    await Promise.allSettled([...this.inFlight]);
  }

  private every(name: string, intervalMs: number, job: () => Promise<unknown>): void {
    let running = false;
    const tick = (): void => {
      if (running || this.stopping) return;
      running = true;
      const run = job()
        .catch((error: unknown) => this.logger.error({ err: error, job: name }, 'periodic job failed'))
        .then(() => undefined)
        .finally(() => {
          running = false;
          this.inFlight.delete(run);
        });
      this.inFlight.add(run);
    };
    tick();
    this.timers.push(setInterval(tick, intervalMs));
  }
}
