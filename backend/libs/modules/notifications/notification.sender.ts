import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { type Job, UnrecoverableError, Worker } from 'bullmq';
import { GrammyError } from 'grammy';
import type { Redis } from 'ioredis';
import type { BotKind } from '@shared/config/env.schema.js';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { QUEUE_REDIS, sendQueueName } from '@shared/queue/queue.module.js';
import { Clock } from '@shared/time/clock.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { BOT_APIS, type BotApiRegistry } from '@telegram/api/bot-api.module.js';
import { NotificationRepository } from './notification.repository.js';
import { NotificationRenderer } from './render.js';
import { BUTTONS_PAYLOAD_KEY, type NotificationButton } from './types.js';

const MAX_ATTEMPTS = 5;
/** Below Telegram's ~30 msg/s per bot (4.1), with headroom (7.5). Per-chat pacing arrives with M4-05. */
const LIMITER = { max: 20, duration: 1000 };
const UNREACHABLE =
  /bot was blocked by the user|user is deactivated|chat not found|bot can't initiate conversation/;
const BLOCKED = /bot was blocked by the user|user is deactivated/;

export interface SendJobData {
  notificationId: string;
}

function keyboardOf(
  payload: Record<string, unknown>,
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | undefined {
  const buttons = payload[BUTTONS_PAYLOAD_KEY];
  if (!Array.isArray(buttons) || buttons.length === 0) return undefined;
  const rows = (buttons as NotificationButton[])
    .filter(
      (b) => typeof b.text === 'string' && typeof b.data === 'string' && Buffer.byteLength(b.data) <= 64,
    )
    .map((b) => [{ text: b.text, callback_data: b.data }]);
  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

/**
 * One BullMQ worker per configured bot (7.5 "Скорость отправки"): claims the notification (`queued` → `sending`),
 * sends, then `sent`. Every non-terminal failure writes the row back to `queued` *before* throwing, so a retry can
 * claim it again; a process crash after `sending` is healed by the scheduler's reconciliation.
 * 429 → the worker pauses for `retry_after`; 4xx → terminal (`failed`), 403/"chat not found" also mark the chat
 * unreachable (NTF-09); other errors retry up to MAX_ATTEMPTS.
 */
@Injectable()
export class NotificationSender implements OnModuleDestroy {
  private readonly logger = new Logger(NotificationSender.name);
  private readonly workers: Worker<SendJobData>[] = [];
  private readonly renderer = new NotificationRenderer();

  constructor(
    private readonly txm: TransactionManager,
    private readonly repo: NotificationRepository,
    private readonly accounts: AccountRepository,
    @Inject(BOT_APIS) private readonly apis: BotApiRegistry,
    @Inject(QUEUE_REDIS) private readonly redis: Redis,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  /** Starts workers only for bots that have a token in this process. */
  start(bots: readonly BotKind[]): BotKind[] {
    const started: BotKind[] = [];
    for (const bot of bots) {
      if (!this.apis.get(bot)) continue;
      const worker = new Worker<SendJobData>(sendQueueName(bot), (job) => this.process(bot, job), {
        connection: this.redis,
        concurrency: 4,
        limiter: LIMITER,
      });
      worker.on('failed', (job, error) => {
        const final =
          job !== undefined &&
          (job.attemptsMade >= (job.opts.attempts ?? 1) || error instanceof UnrecoverableError);
        const log = final ? this.logger.error.bind(this.logger) : this.logger.warn.bind(this.logger);
        log({ err: error, job: job?.id, final }, `send-${bot} job failed`);
      });
      this.workers.push(worker);
      started.push(bot);
    }
    return started;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
  }

  /** Exposed for tests; the queue worker calls it per job. */
  async process(
    bot: BotKind,
    job: Pick<Job<SendJobData>, 'data' | 'attemptsMade'>,
  ): Promise<'sent' | 'skipped'> {
    const claimed = await this.txm.run(async () => {
      const n = await this.repo.findById(job.data.notificationId, { forUpdate: true });
      if (!n || n.status !== 'queued') return null; // already sent, cancelled, or a duplicate job
      await this.repo.setStatus([n.id], 'sending');
      return n;
    });
    if (!claimed) return 'skipped';

    const [chat, recipient] = await Promise.all([
      this.accounts.findBotChat(claimed.recipientId, bot),
      this.accounts.findById(claimed.recipientId),
    ]);
    if (!chat?.isReachable || !recipient || recipient.status === 'blocked') {
      const reason = !chat ? 'no chat' : !chat.isReachable ? 'unreachable' : 'blocked';
      await this.repo.setStatus([claimed.id], 'skipped', { error: reason });
      return 'skipped';
    }
    const body = this.renderer.render(claimed, recipient.locale);
    // NTF-03 / NTF-04: a copy or a stand-in message is signed with whom it is about
    const forName = typeof claimed.payload['forName'] === 'string' ? claimed.payload['forName'] : '';
    const header =
      claimed.route && body
        ? this.renderer.render(
            {
              typeCode: claimed.route === 'cc' ? 'header.cc' : 'header.via_parent',
              payload: { name: forName },
            },
            recipient.locale,
          )
        : null;
    const text = body && header ? `${header}\n${body}` : body;
    if (!text) {
      await this.repo.setStatus([claimed.id], 'failed', { error: `no template for ${claimed.typeCode}` });
      return 'skipped';
    }
    const api = this.apis.get(bot);
    if (!api) {
      await this.repo.setStatus([claimed.id], 'scheduled'); // another process with the token will pick it up
      throw new UnrecoverableError(`bot ${bot} is not configured here`);
    }
    try {
      await api.sendMessage(chat.chatId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboardOf(claimed.payload),
      });
    } catch (error) {
      await this.handleFailure(bot, claimed.id, claimed.recipientId, job.attemptsMade, error);
    }
    await this.repo.setStatus([claimed.id], 'sent', { sentAt: this.clock.now(), error: null });
    return 'sent';
  }

  private async handleFailure(
    bot: BotKind,
    id: string,
    recipientId: string,
    attempt: number,
    error: unknown,
  ): Promise<never> {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof GrammyError && error.error_code === 429) {
      await this.repo.setStatus([id], 'queued', { error: message });
      const retryAfter = (error.parameters.retry_after ?? 5) * 1000;
      const worker = this.workers.find((w) => w.name === sendQueueName(bot));
      if (worker) await worker.rateLimit(retryAfter);
      throw Worker.RateLimitError();
    }
    if (error instanceof GrammyError && error.error_code >= 400 && error.error_code < 500) {
      // Telegram will not accept this message as is: do not retry (bad entities, forbidden, unknown chat).
      await this.repo.setStatus([id], 'failed', { error: error.description }); // first: the row must not stay `sending`
      if (UNREACHABLE.test(error.description)) {
        // NTF-09: one warning per incident — only when the chat just flipped to unreachable, and only for a
        // person who blocked or deleted the account (a chat never opened is not an incident)
        const flipped = await this.txm.run(() =>
          this.accounts.markBotChatUnreachable(recipientId, bot, error.description),
        );
        if (flipped && BLOCKED.test(error.description)) {
          await this.outbox.publish({
            type: 'channel.unreachable',
            aggregateType: 'account',
            aggregateId: recipientId,
            payload: { accountId: recipientId, bot, error: error.description },
          });
        }
      }
      throw new UnrecoverableError(error.description);
    }
    await this.repo.bumpAttempts(id, message);
    if (attempt + 1 >= MAX_ATTEMPTS) {
      await this.repo.setStatus([id], 'failed', { error: message });
      throw new UnrecoverableError(message);
    }
    await this.repo.setStatus([id], 'queued');
    throw error instanceof Error ? error : new Error(message);
  }
}
