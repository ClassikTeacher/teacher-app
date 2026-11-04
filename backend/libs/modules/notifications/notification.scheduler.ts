import { Inject, Injectable, Logger } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { QUEUES, type QueueRegistry, sendQueueName } from '@shared/queue/queue.module.js';
import { Clock, MINUTE_MS } from '@shared/time/clock.js';
import type { Bot } from '@modules/identity/schema.js';
import { NotificationRepository } from './notification.repository.js';
import type { NotificationRow } from './schema.js';

const BATCH = 200;
/** A row in `sending` longer than this lost its process mid-send: re-send (rare duplicate accepted, 10.4). */
const STUCK_SENDING_MS = 5 * MINUTE_MS;
/** A row in `queued` longer than this lost its Redis job (flush, failover, eviction): re-enqueue. */
const STUCK_QUEUED_MS = 15 * MINUTE_MS;

/**
 * Every 30 s (7.5): takes due notifications with `FOR UPDATE SKIP LOCKED`, enqueues one job per notification
 * on the bot's send queue (job id = notification uuid; the dedupe key already guarantees NTF-08 at insert
 * time) and marks them `queued`. Enqueue happens inside the row-locking transaction on purpose: a worker that
 * picks the job up early blocks on the row lock in `NotificationSender.process` and re-reads `queued`
 * after commit (READ COMMITTED). If the queue is unreachable the transaction rolls back and the rows stay
 * `scheduled` for the next tick. Each tick also reconciles rows stuck in `sending` or `queued`.
 */
@Injectable()
export class NotificationScheduler {
  private readonly logger = new Logger(NotificationScheduler.name);

  constructor(
    private readonly txm: TransactionManager,
    private readonly repo: NotificationRepository,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    private readonly clock: Clock,
  ) {}

  async tick(): Promise<number> {
    await this.reconcile();
    return this.txm.run(async () => {
      const due = await this.repo.lockDue(this.clock.now(), BATCH);
      if (due.length === 0) return 0;
      const byBot = new Map<Bot, NotificationRow[]>();
      for (const n of due) byBot.set(n.bot, [...(byBot.get(n.bot) ?? []), n]);
      let queued = 0;
      for (const [bot, items] of byBot) {
        await this.queues
          .get(sendQueueName(bot))
          .addBulk(
            items.map((n) => ({ name: n.typeCode, data: { notificationId: n.id }, opts: { jobId: n.id } })),
          );
        await this.repo.setStatus(
          items.map((n) => n.id),
          'queued',
        );
        queued += items.length;
      }
      this.logger.debug({ count: queued }, 'notifications queued');
      return queued;
    });
  }

  /** Returns stuck rows to `scheduled` so the normal path picks them up again. */
  async reconcile(): Promise<number> {
    const now = this.clock.now();
    const stuck = await this.repo.requeueStuck({
      sendingBefore: new Date(now.getTime() - STUCK_SENDING_MS),
      queuedBefore: new Date(now.getTime() - STUCK_QUEUED_MS),
    });
    if (stuck > 0) this.logger.warn({ count: stuck }, 'stuck notifications returned to scheduled');
    return stuck;
  }
}
