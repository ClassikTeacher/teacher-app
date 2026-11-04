import { createHash, randomBytes } from 'node:crypto';
import type { Bot, InvitationKind, InvitationRow, Role } from './schema.js';

/** Lifetimes (INV-02: 72 h for staff; bootstrap 24 h per 5.1.1; student/parent 7 days per 5.4.2). */
export const INVITATION_TTL_HOURS: Record<InvitationKind, number> = {
  bootstrap: 24,
  teacher: 72,
  admin: 72,
  student: 7 * 24,
  parent: 7 * 24,
};

/** Which bot the deep link opens (4.1). */
export const INVITATION_BOT: Record<InvitationKind, Bot> = {
  bootstrap: 'auth',
  teacher: 'auth',
  admin: 'auth',
  student: 'student',
  parent: 'parent',
};

export const STAFF_INVITATION_ROLE: Partial<Record<InvitationKind, Role>> = {
  bootstrap: 'SUPER_ADMIN',
  teacher: 'TEACHER',
  admin: 'ADMIN',
};

export type InvitationRejection = 'expired' | 'used' | 'revoked' | 'not_for_you';
export type InvitationCheck = { ok: true } | { ok: false; reason: InvitationRejection };

type Checkable = Pick<
  InvitationRow,
  'status' | 'expiresAt' | 'targetTelegramUserId' | 'maxUses' | 'usedCount'
>;

/** Pure rule: can this Telegram user redeem the invitation now? (INV-02, INV-03) */
export function checkRedeemable(inv: Checkable, now: Date, telegramUserId: number): InvitationCheck {
  if (inv.status === 'revoked') return { ok: false, reason: 'revoked' };
  if (inv.status === 'used' || inv.usedCount >= inv.maxUses) return { ok: false, reason: 'used' };
  if (inv.status === 'expired' || inv.expiresAt.getTime() <= now.getTime())
    return { ok: false, reason: 'expired' };
  if (inv.targetTelegramUserId !== null && inv.targetTelegramUserId !== telegramUserId) {
    return { ok: false, reason: 'not_for_you' };
  }
  return { ok: true };
}

/** 32 random bytes as base64url: 43 chars of [A-Za-z0-9_-], within Telegram's 64-char deep-link limit. */
export function generateInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

export const INVITATION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Only the hash is stored (INV-05). */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function invitationDeepLink(botUsername: string, token: string): string {
  return `https://t.me/${botUsername}?start=${token}`;
}
