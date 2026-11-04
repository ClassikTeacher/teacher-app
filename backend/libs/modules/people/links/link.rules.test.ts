import { describe, expect, it } from 'vitest';
import { AppError } from '@shared/errors/app-error.js';
import {
  acceptOutcome,
  assertLinkActive,
  assertParentLimit,
  assertStudentLimit,
  linkView,
  normalizeWeeklyLimit,
} from './link.rules.js';

describe('link rules (PPL, LINK, 8.0)', () => {
  it('normalizes the weekly limit: null = no limit, integers 1..50 only (PPL-06)', () => {
    expect(normalizeWeeklyLimit(null)).toBeNull();
    expect(normalizeWeeklyLimit(undefined)).toBeNull();
    expect(normalizeWeeklyLimit(2)).toBe(2);
    expect(() => normalizeWeeklyLimit(0)).toThrow(AppError);
    expect(() => normalizeWeeklyLimit(1.5)).toThrow(AppError);
    expect(() => normalizeWeeklyLimit(51)).toThrow(AppError);
  });

  it('accepting a card: new pair → new, ended pair → reopen, active pair → CONFLICT (UC-10 5б)', () => {
    expect(acceptOutcome(null)).toBe('new');
    expect(acceptOutcome({ status: 'ended' })).toBe('reopen');
    expect(acceptOutcome({ status: 'declined' })).toBe('new');
    expect(() => acceptOutcome({ status: 'active' })).toThrow(/already linked/);
  });

  it('read policy 8.0: full for active links, archive when ended or the teacher is blocked, none when blocked', () => {
    expect(linkView({ status: 'active' }, 'active', 'active')).toBe('full');
    expect(linkView({ status: 'active' }, 'blocked', 'active')).toBe('archive'); // ACC-04
    expect(linkView({ status: 'ended' }, 'active', 'active')).toBe('archive');
    expect(linkView({ status: 'ended' }, 'active', 'blocked')).toBe('none'); // ACC-01
    expect(linkView({ status: 'pending' }, 'active', 'active')).toBe('none');
  });

  it('guards: link must be active; student and parent limits', () => {
    expect(() => assertLinkActive({ status: 'ended' })).toThrow(AppError);
    expect(() => assertLinkActive({ status: 'active' })).not.toThrow();
    expect(() => assertStudentLimit(3, 3)).toThrow(/limit/i);
    expect(() => assertStudentLimit(3, null)).not.toThrow();
    expect(() => assertStudentLimit(2, 3)).not.toThrow();
    expect(() => assertParentLimit(4)).toThrow(/four parents/);
    expect(() => assertParentLimit(3)).not.toThrow();
  });
});
