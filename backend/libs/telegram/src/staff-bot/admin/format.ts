import type { AccountRow, Role } from '@modules/identity/schema.js';
import type { BotContext } from '../../core/context.js';
import { fullName } from '../../core/format.js';
import { escapeHtml } from '../../core/ui.js';

export { fullName };

export type AccountWithRoles = AccountRow & { roles: Role[] };

/** One-line label for lists and buttons (plain text, no HTML). */
export function accountLabel(a: Pick<AccountRow, 'firstName' | 'lastName' | 'username' | 'status'>): string {
  const name = fullName(a);
  const handle = a.username ? ` @${a.username}` : '';
  const mark = a.status === 'blocked' ? ' ⛔' : a.status !== 'active' ? ' ⏳' : '';
  return `${name}${handle}${mark}`;
}

/** Account card body (HTML-escaped). */
export function accountCard(ctx: BotContext, a: AccountWithRoles): string {
  const roles = a.roles.map((r) => ctx.t(`role-${r.toLowerCase()}`)).join(', ') || '—';
  const lines = [
    `<b>${escapeHtml(fullName(a))}</b>${a.username ? ` · @${escapeHtml(a.username)}` : ''}`,
    `${ctx.t('card-status')}: ${ctx.t(`status-${a.status}`)}`,
    `${ctx.t('card-roles')}: ${escapeHtml(roles)}`,
    `${ctx.t('card-timezone')}: ${escapeHtml(a.timezone)}`,
  ];
  if (a.status === 'blocked' && a.blockReason)
    lines.push(`${ctx.t('card-block-reason')}: ${escapeHtml(a.blockReason)}`);
  return lines.join('\n');
}

export function pageLabel(page: number, pages: number): string {
  return `${page}/${pages}`;
}
