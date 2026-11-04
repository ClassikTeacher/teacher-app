import { InlineKeyboard } from 'grammy';
import { cb, MENU_NS } from '../core/callback.js';
import type { BotContext } from '../core/context.js';
import { renderMenu } from '../core/ui.js';

export const menuCb = (action: string, ...args: Array<string | number>): string =>
  cb(MENU_NS, action, ...args);

/** Two-column grid of sections, payload `m:open:<key>`; labels come from `<prefix>-<key>`. */
export function sectionGrid(ctx: BotContext, prefix: string, keys: readonly string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  keys.forEach((key, i) => {
    keyboard.text(ctx.t(`${prefix}-${key}`), menuCb('open', key));
    if (i % 2 === 1) keyboard.row();
  });
  if (keys.length % 2 === 1) keyboard.row();
  return keyboard;
}

export function backToMain(ctx: BotContext): InlineKeyboard {
  return new InlineKeyboard().text(ctx.t('btn-back'), menuCb('main'));
}

/** Placeholder for sections that arrive in later milestones. */
export async function renderSoon(ctx: BotContext, label: string): Promise<void> {
  await renderMenu(ctx, ctx.t('person-section-soon', { section: label }), backToMain(ctx));
}
