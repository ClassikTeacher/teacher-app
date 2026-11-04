import { GrammyError, type InlineKeyboard } from 'grammy';
import type { BotContext } from './context.js';

const NOT_MODIFIED = /message is not modified/;
const CANNOT_EDIT = /message can't be edited|message to edit not found/;

/**
 * Renders the bot's single menu message: edits it in place when the user pressed a button on it,
 * otherwise sends a fresh message and remembers its id (4.4 "Одно сообщение-меню").
 */
export async function renderMenu(ctx: BotContext, text: string, keyboard?: InlineKeyboard): Promise<void> {
  const pressed = ctx.callbackQuery?.message;
  const replyMarkup = keyboard ?? { inline_keyboard: [] };
  if (pressed && ctx.session.menuMessageId === pressed.message_id) {
    try {
      await ctx.editMessageText(text, { reply_markup: replyMarkup, parse_mode: 'HTML' });
      return;
    } catch (error) {
      if (error instanceof GrammyError && NOT_MODIFIED.test(error.description)) return;
      if (!(error instanceof GrammyError && CANNOT_EDIT.test(error.description))) throw error;
    }
  }
  const sent = await ctx.reply(text, { reply_markup: replyMarkup, parse_mode: 'HTML' });
  ctx.session.menuMessageId = sent.message_id;
}

/** Plain message outside the menu (confirmations, cards to forward). */
export async function say(ctx: BotContext, text: string, keyboard?: InlineKeyboard): Promise<void> {
  await ctx.reply(text, { reply_markup: keyboard, parse_mode: 'HTML' });
}

/** Acknowledges a button press; failures (stale query) are not worth surfacing. */
export async function ack(ctx: BotContext, text?: string): Promise<void> {
  if (!ctx.callbackQuery) return;
  await ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => undefined);
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface Page<T> {
  items: T[];
  page: number;
  pages: number;
}

/** Slices a list for paginated keyboards (4.4 "Списки с пагинацией"). */
export function paginate<T>(all: readonly T[], page: number, pageSize = 8): Page<T> {
  const pages = Math.max(1, Math.ceil(all.length / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  return { items: all.slice((current - 1) * pageSize, current * pageSize), page: current, pages };
}
