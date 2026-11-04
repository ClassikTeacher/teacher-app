import type { AccountRow } from '@modules/identity/schema.js';
import { fullName } from '../core/format.js';
import { escapeHtml } from '../core/ui.js';

/** One HTML line for a parent in lists shared by StaffBot and StudentBot: name and handle. */
export function parentLine(parent: Pick<AccountRow, 'firstName' | 'lastName' | 'username'>): string {
  const handle = parent.username ? ` · @${escapeHtml(parent.username)}` : '';
  return `${escapeHtml(fullName(parent))}${handle}`;
}
