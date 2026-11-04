import { describe, expect, it } from 'vitest';
import {
  checkRedeemable,
  generateInvitationToken,
  hashInvitationToken,
  INVITATION_TOKEN,
  invitationDeepLink,
} from './invitation.rules.js';

const now = new Date('2026-10-19T12:00:00Z');
const base = {
  status: 'pending' as const,
  expiresAt: new Date('2026-10-20T12:00:00Z'),
  targetTelegramUserId: null,
  maxUses: 1,
  usedCount: 0,
};

describe('checkRedeemable (INV-02, INV-03)', () => {
  it('accepts a pending, unexpired, unbound invitation for anyone', () => {
    expect(checkRedeemable(base, now, 42)).toEqual({ ok: true });
  });

  it('rejects expired invitations, including exactly at the deadline', () => {
    expect(checkRedeemable({ ...base, expiresAt: now }, now, 42)).toEqual({ ok: false, reason: 'expired' });
    expect(checkRedeemable({ ...base, status: 'expired' }, now, 42)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects used and revoked invitations', () => {
    expect(checkRedeemable({ ...base, status: 'used' }, now, 42)).toEqual({ ok: false, reason: 'used' });
    expect(checkRedeemable({ ...base, usedCount: 1 }, now, 42)).toEqual({ ok: false, reason: 'used' });
    expect(checkRedeemable({ ...base, status: 'revoked' }, now, 42)).toEqual({
      ok: false,
      reason: 'revoked',
    });
  });

  it('rejects another person when bound to a Telegram user id', () => {
    expect(checkRedeemable({ ...base, targetTelegramUserId: 7 }, now, 42)).toEqual({
      ok: false,
      reason: 'not_for_you',
    });
    expect(checkRedeemable({ ...base, targetTelegramUserId: 42 }, now, 42)).toEqual({ ok: true });
  });

  it('checks revocation before use and expiry', () => {
    expect(checkRedeemable({ ...base, status: 'revoked', usedCount: 1 }, now, 42)).toEqual({
      ok: false,
      reason: 'revoked',
    });
  });
});

describe('tokens (INV-05, Telegram deep-link limits)', () => {
  it('generates 43-char base64url tokens that fit the 64-char start parameter', () => {
    const token = generateInvitationToken();
    expect(token).toMatch(INVITATION_TOKEN);
    expect(generateInvitationToken()).not.toBe(token);
  });

  it('hashes deterministically with sha256 hex', () => {
    expect(hashInvitationToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('builds a t.me deep link', () => {
    expect(invitationDeepLink('TutorAuthBot', 'tok')).toBe('https://t.me/TutorAuthBot?start=tok');
  });
});
