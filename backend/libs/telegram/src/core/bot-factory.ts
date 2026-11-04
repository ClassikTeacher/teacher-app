import { autoRetry } from '@grammyjs/auto-retry';
import type { I18n } from '@grammyjs/i18n';
import { sequentialize } from '@grammyjs/runner';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { Bot, BotError, GrammyError, type MiddlewareFn } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import type { BotKind } from '@shared/config/env.schema.js';
import { AppError } from '@shared/errors/app-error.js';
import { runWithCorrelation } from '@shared/logging/correlation.js';
import type { ResolvedActor } from '@modules/identity/actor-resolver.js';
import type { BotContext } from './context.js';
import { FlowRegistry } from './flow.js';

export interface BotDeps {
  kind: BotKind;
  token: string;
  i18n: I18n<BotContext>;
  session: MiddlewareFn<BotContext>;
  resolveActor: (telegramUserId: number) => Promise<ResolvedActor | null>;
  /** Returns false when this update id was already processed (Redis `SET NX`); undefined = no dedup. */
  isFreshUpdate?: (updateId: number) => Promise<boolean>;
  /** Called when Telegram reports the user blocked the bot (403) while we were replying. */
  onBlockedByUser?: (actor: ResolvedActor) => Promise<void>;
  /** Records the private chat of a known account for this bot (notifications need chat ids). */
  registerChat?: (actor: ResolvedActor, chatId: number) => Promise<void>;
  log: { error: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void };
  /** Skips the `getMe` call (tests). */
  botInfo?: UserFromGetMe;
  /** Disable the outgoing throttler (tests). */
  throttle?: boolean;
}

export interface CreatedBot {
  bot: Bot<BotContext>;
  flows: FlowRegistry;
  /**
   * Processes one update with the error boundary applied. grammY's public `handleUpdate` rethrows middleware
   * errors (only long polling routes them through `bot.catch`), so webhooks and tests must go through this.
   */
  handle(update: Update): Promise<void>;
  /** Installs the flow router and the fallback; call after registering commands and menus. */
  finalize(): void;
}

const BLOCKED_BY_USER = /bot was blocked by the user|user is deactivated|chat not found/;
/** Used when i18n is not available yet (failure before the i18n middleware ran). */
const FALLBACK_ERROR_TEXT = 'Что-то пошло не так. Попробуйте ещё раз чуть позже.';

/**
 * Shared bot wiring (M1-05 infrastructure): correlation ids, update de-duplication, per-chat serialisation,
 * Redis session, actor resolution, i18n, auto-retry and throttling of outgoing calls, and one error boundary.
 */
export function createBot(deps: BotDeps): CreatedBot {
  const bot = new Bot<BotContext>(deps.token, { botInfo: deps.botInfo });
  if (deps.throttle !== false) bot.api.config.use(apiThrottler());
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));

  bot.use(async (ctx, next) => {
    await runWithCorrelation(() => next(), { context: { bot: deps.kind, update_id: ctx.update.update_id } });
  });
  if (deps.isFreshUpdate) {
    const isFresh = deps.isFreshUpdate;
    bot.use(async (ctx, next) => {
      if (await isFresh(ctx.update.update_id)) await next();
    });
  }
  bot.use(sequentialize((ctx) => (ctx.chat?.id === undefined ? undefined : `${deps.kind}:${ctx.chat.id}`)));
  bot.use(deps.session);
  bot.use(async (ctx, next) => {
    ctx.bot = deps.kind;
    ctx.actor = ctx.from ? await deps.resolveActor(ctx.from.id) : null;
    const chat = ctx.chat;
    if (
      ctx.actor &&
      chat?.type === 'private' &&
      deps.registerChat &&
      ctx.session.chatRegisteredFor !== ctx.actor.account.id
    ) {
      await deps.registerChat(ctx.actor, chat.id);
      ctx.session.chatRegisteredFor = ctx.actor.account.id;
    }
    await next();
  });
  bot.use(deps.i18n.middleware());

  // Reachability follows Telegram's own signal: unblocking the bot sends `my_chat_member` with status `member`.
  bot.on('my_chat_member', async (ctx) => {
    const status = ctx.myChatMember.new_chat_member.status;
    if (!ctx.actor || ctx.chat.type !== 'private') return;
    if (status === 'kicked' || status === 'left') {
      if (deps.onBlockedByUser) await deps.onBlockedByUser(ctx.actor);
      ctx.session.chatRegisteredFor = undefined; // the next update re-registers the chat as reachable (L-7)
    } else if (status === 'member' && deps.registerChat) {
      await deps.registerChat(ctx.actor, ctx.chat.id);
      ctx.session.chatRegisteredFor = ctx.actor.account.id;
    }
  });

  const flows = new FlowRegistry();

  const errorHandler = async (error: BotError<BotContext>): Promise<void> => {
    const { ctx } = error;
    const cause = error.error;
    try {
      // Stop the client spinner even when the handler failed before acknowledging.
      if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => undefined);
      if (
        cause instanceof GrammyError &&
        cause.error_code === 403 &&
        BLOCKED_BY_USER.test(cause.description)
      ) {
        if (ctx.actor && deps.onBlockedByUser) await deps.onBlockedByUser(ctx.actor);
        return;
      }
      const t = typeof ctx.t === 'function' ? ctx.t.bind(ctx) : null;
      if (cause instanceof AppError) {
        deps.log.warn({ code: cause.code, details: cause.details }, 'domain error in bot handler');
        const key = `error-${cause.code.toLowerCase().replace(/_/g, '-')}`;
        const text = t ? t(key) : FALLBACK_ERROR_TEXT;
        const missing = text === key || text === `{${key}}`;
        await ctx.reply(missing ? (t ? t('error-internal') : FALLBACK_ERROR_TEXT) : text);
        return;
      }
      deps.log.error({ err: cause, update_id: ctx.update.update_id }, 'unhandled error in bot handler');
      await ctx.reply(t ? t('error-internal') : FALLBACK_ERROR_TEXT);
    } catch (nested) {
      // Never let the error handler itself throw: it would kill the polling runner.
      deps.log.error({ err: nested, update_id: ctx.update.update_id }, 'error handler failed');
    }
  };
  bot.catch(errorHandler);

  return {
    bot,
    flows,
    handle: async (update) => {
      try {
        await bot.handleUpdate(update);
      } catch (error) {
        if (!(error instanceof BotError)) throw error;
        await errorHandler(error as BotError<BotContext>);
      }
    },
    finalize: () => {
      bot.use(flows.middleware());
      bot.on('callback_query:data', async (ctx) => {
        await ctx.answerCallbackQuery({ text: ctx.t('callback-stale') }).catch(() => undefined);
      });
      bot.on('message:text', async (ctx) => {
        await ctx.reply(ctx.t('fallback-start-over'));
      });
    },
  };
}
