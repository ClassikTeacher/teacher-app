import type { AccountRow } from '@modules/identity/schema.js';

/** Display name of an account for messages and button labels (plain text; escape before HTML use). */
export function fullName(a: Pick<AccountRow, 'firstName' | 'lastName'>): string {
  return `${a.firstName} ${a.lastName}`.trim() || '—';
}

/** Shortens a label so it fits an inline button comfortably. */
export function clip(value: string, max = 40): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
