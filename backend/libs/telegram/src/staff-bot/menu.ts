import { InlineKeyboard } from 'grammy';
import { type Actor, isAdmin, isSuperAdmin } from '@modules/access/actor.js';
import type { ResolvedFeatures } from '@modules/access/features/rules.js';
import { cb, MENU_NS } from '../core/callback.js';
import type { BotContext } from '../core/context.js';
import { allowedSections, type SectionDef, type StaffSection } from './sections.js';

export const menuCb = (action: string, ...args: Array<string | number>): string =>
  cb(MENU_NS, action, ...args);

interface Screen {
  text: string;
  keyboard: InlineKeyboard;
}

function grid(ctx: BotContext, sections: readonly SectionDef[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  sections.forEach((s, i) => {
    keyboard.text(ctx.t(`menu-${s.key}`), menuCb('open', s.key));
    if (i % 2 === 1) keyboard.row();
  });
  if (sections.length % 2 === 1) keyboard.row();
  return keyboard;
}

/** Main menu: the teacher sections the person is entitled to (roles + features) plus the admin entry. */
export function buildMainMenu(ctx: BotContext, actor: Actor, features: ResolvedFeatures | null): Screen {
  const allowed = allowedSections(actor, features);
  const keyboard = grid(
    ctx,
    allowed.filter((s) => s.parent === 'main'),
  );
  if (allowed.some((s) => s.parent === 'admin'))
    keyboard.text(ctx.t('menu-admin-section'), menuCb('admin')).row();
  const roles = [
    isSuperAdmin(actor) ? ctx.t('role-super_admin') : isAdmin(actor) ? ctx.t('role-admin') : null,
    actor.roles.includes('TEACHER') ? ctx.t('role-teacher') : null,
  ]
    .filter(Boolean)
    .join(', ');
  return { text: ctx.t('staff-main-menu', { roles }), keyboard };
}

export function buildAdminMenu(ctx: BotContext, actor: Actor, features: ResolvedFeatures | null): Screen {
  const keyboard = grid(
    ctx,
    allowedSections(actor, features).filter((s) => s.parent === 'admin'),
  );
  keyboard.text(ctx.t('btn-back'), menuCb('main')).row();
  return { text: ctx.t('staff-admin-menu'), keyboard };
}

export function backKeyboard(ctx: BotContext, parent: 'main' | 'admin' = 'main'): InlineKeyboard {
  return new InlineKeyboard().text(ctx.t('btn-back'), menuCb(parent));
}

/** Back button that returns to a section screen. */
export function backToSection(ctx: BotContext, section: StaffSection): InlineKeyboard {
  return new InlineKeyboard().text(ctx.t('btn-back'), menuCb('open', section));
}
