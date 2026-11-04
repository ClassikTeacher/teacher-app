import type { InlineKeyboard, MiddlewareFn } from 'grammy';
import type { Actor } from '@modules/access/actor.js';
import type { BotContext } from './context.js';

export interface RequireActorOptions {
  /** Who is allowed in (roles/status already checked for blocked and onboarding). */
  allow: (actor: Actor) => boolean;
  /** i18n keys of the refusals. */
  texts: { stranger: string; onboarding: string; notAllowed: string; blocked?: string };
  /** Optional keyboard attached to the stranger/onboarding refusals (e.g. a link to AuthBot). */
  keyboard?: (ctx: BotContext) => InlineKeyboard | undefined;
  /** Runs when a user is refused (e.g. to clear chat-scoped commands). */
  onRefused?: (ctx: BotContext) => Promise<void>;
}

/**
 * Entry gate of a bot: applies only to messages and button presses (service updates such as
 * `my_chat_member` pass through untouched), answers callback queries so the client spinner stops,
 * and refuses strangers, blocked and not-yet-onboarded accounts with the right text.
 */
export function requireActor(options: RequireActorOptions): MiddlewareFn<BotContext> {
  const refuse = async (ctx: BotContext, key: string, withKeyboard: boolean): Promise<void> => {
    const text = ctx.t(key);
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text, show_alert: true }).catch(() => undefined);
      return;
    }
    if (ctx.chat) await ctx.reply(text, { reply_markup: withKeyboard ? options.keyboard?.(ctx) : undefined });
    await options.onRefused?.(ctx);
  };
  return async (ctx, next) => {
    if (!ctx.message && !ctx.callbackQuery) return next();
    const actor = ctx.actor?.actor;
    if (!actor) return refuse(ctx, options.texts.stranger, true);
    if (actor.status === 'blocked') return refuse(ctx, options.texts.blocked ?? 'account-blocked', false);
    if (actor.status !== 'active') return refuse(ctx, options.texts.onboarding, true);
    if (!options.allow(actor)) return refuse(ctx, options.texts.notAllowed, false);
    await next();
  };
}
