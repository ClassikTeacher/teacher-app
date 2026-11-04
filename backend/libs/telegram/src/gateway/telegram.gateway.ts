import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { run, type RunnerHandle } from '@grammyjs/runner';
import type { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import type { Redis } from 'ioredis';
import { botConfigs, type BotKind, ENV, type Env } from '@shared/config/index.js';
import { AppError } from '@shared/errors/app-error.js';
import { REDIS } from '@shared/redis/redis.module.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { createBot, type CreatedBot } from '../core/bot-factory.js';
import type { BotContext } from '../core/context.js';
import { createI18n } from '../core/i18n.js';
import { createSessionMiddleware } from '../core/session.js';
import { BOT_DEFINITIONS, type BotDefinition } from './bot-definition.js';

const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member'] as const;
const UPDATE_DEDUP_TTL_SECONDS = 60 * 60;
const DRAIN_TIMEOUT_MS = 10_000;

async function retry<T>(fn: () => Promise<T>, attempts: number, logger: Logger, what: string): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts) throw error;
      logger.warn({ err: error, attempt }, `${what} failed; retrying`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

/**
 * One gateway for four tokens (4.2): builds the bots that have tokens, runs long polling in dev and
 * registers webhooks in production. Webhook updates are acknowledged immediately and processed
 * asynchronously; in-flight updates are drained on shutdown and late arrivals get 503 so Telegram retries.
 * `sequentialize` keeps per-chat ordering inside one process (T-08: the MVP runs a single `api` replica).
 */
@Injectable()
export class TelegramGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramGateway.name);
  private readonly bots = new Map<BotKind, CreatedBot>();
  private readonly runners: RunnerHandle[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private shuttingDown = false;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(BOT_DEFINITIONS) private readonly definitions: BotDefinition[],
    private readonly actors: ActorResolver,
    private readonly accounts: AccountRepository,
  ) {}

  get(kind: BotKind): Bot<BotContext> | undefined {
    return this.bots.get(kind)?.bot;
  }

  async onModuleInit(): Promise<void> {
    if (this.env.TELEGRAM_MODE === 'off') return;
    const i18n = createI18n();
    const configs = botConfigs(this.env);
    for (const definition of this.definitions) {
      const config = configs[definition.kind];
      if (!config.token) continue;
      const created = createBot({
        kind: definition.kind,
        token: config.token,
        i18n,
        session: createSessionMiddleware(this.redis, definition.kind),
        resolveActor: (id) => this.actors.byTelegramUserId(id, 'bot'),
        isFreshUpdate: (updateId) => this.isFreshUpdate(definition.kind, updateId),
        onBlockedByUser: async (actor) => {
          await this.accounts.markBotChatUnreachable(actor.account.id, definition.kind, 'blocked by user');
        },
        registerChat: async (actor, chatId) => {
          if (definition.registersChatFor && !definition.registersChatFor(actor.actor)) return;
          await this.accounts.upsertBotChat(actor.account.id, definition.kind, chatId);
        },
        log: {
          error: (obj, msg) => this.logger.error(obj, msg),
          warn: (obj, msg) => this.logger.warn(obj, msg),
        },
      });
      definition.setup(created);
      created.finalize();
      this.bots.set(definition.kind, created);
    }
    await Promise.all([...this.bots].map(([kind, created]) => this.connect(kind, created.bot)));
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all(this.runners.filter((r) => r.isRunning()).map((r) => r.stop()));
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await Promise.race([Promise.allSettled([...this.inFlight]), new Promise((r) => setTimeout(r, 200))]);
    }
  }

  /** Constant-time check of `X-Telegram-Bot-Api-Secret-Token`; used by the webhook guard. */
  isValidWebhookSecret(secret: string | undefined): boolean {
    const expected = this.env.TELEGRAM_WEBHOOK_SECRET ?? '';
    if (!expected || !secret || secret.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(secret), Buffer.from(expected));
  }

  /** Called by the webhook controller after the guard verified the secret. */
  dispatchWebhook(kind: BotKind, update: Update): void {
    const created = this.bots.get(kind);
    if (!created) throw AppError.notFound('bot', kind);
    if (this.shuttingDown) throw new AppError('RATE_LIMITED', 'Shutting down; retry later');
    const task = created
      .handle(update)
      .catch((error: unknown) =>
        this.logger.error({ err: error, update_id: update.update_id }, 'webhook update failed'),
      )
      .finally(() => this.inFlight.delete(task));
    this.inFlight.add(task);
  }

  private async isFreshUpdate(kind: BotKind, updateId: number): Promise<boolean> {
    try {
      const result = await this.redis.set(
        `tg:upd:${kind}:${updateId}`,
        '1',
        'EX',
        UPDATE_DEDUP_TTL_SECONDS,
        'NX',
      );
      return result === 'OK';
    } catch (error) {
      this.logger.warn({ err: error }, 'update dedup unavailable; processing without it');
      return true;
    }
  }

  private async connect(kind: BotKind, bot: Bot<BotContext>): Promise<void> {
    try {
      await retry(() => bot.init(), 3, this.logger, `${kind} init`);
      const definition = this.definitions.find((d) => d.kind === kind)!;
      await bot.api
        .setMyCommands([...definition.commands])
        .catch((error: unknown) => this.logger.warn({ err: error, bot: kind }, 'setMyCommands failed'));
      if (this.env.TELEGRAM_MODE === 'polling') {
        await bot.api
          .deleteWebhook({ drop_pending_updates: false })
          .catch((error: unknown) => this.logger.warn({ err: error, bot: kind }, 'deleteWebhook failed'));
        const runner = run(bot, { runner: { fetch: { allowed_updates: [...ALLOWED_UPDATES] } } });
        runner
          .task()
          ?.catch((error: unknown) => this.logger.error({ err: error, bot: kind }, 'polling runner crashed'));
        this.runners.push(runner);
        this.logger.log(`${kind} bot: long polling started as @${bot.botInfo.username}`);
      } else {
        const url = `${this.env.PUBLIC_BASE_URL}/api/v1/tg/${kind}/webhook`;
        await retry(
          () =>
            bot.api.setWebhook(url, {
              secret_token: this.env.TELEGRAM_WEBHOOK_SECRET,
              allowed_updates: [...ALLOWED_UPDATES],
              drop_pending_updates: false,
            }),
          3,
          this.logger,
          `${kind} setWebhook`,
        );
        this.logger.log(`${kind} bot: webhook registered as @${bot.botInfo.username}`);
      }
    } catch (error) {
      this.logger.error(
        { err: error, bot: kind },
        'bot failed to connect; it will stay offline until restart',
      );
    }
  }
}
