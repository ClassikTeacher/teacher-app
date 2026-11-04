import { describe, expect, it } from 'vitest';
import { AppError } from '@shared/errors/app-error.js';
import { checkCancel, isLateCancel, normalizeCancelReason } from './cancel.rules.js';

const now = new Date('2026-10-20T10:00:00Z');
const lesson = (startIso: string, groupId: string | null = null, status = 'scheduled' as const) => {
  const startsAt = new Date(startIso);
  return { status, startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000), groupId };
};
const profile = {
  lateCancelHours: 24,
  studentCancelCutoffHours: null as number | null,
  studentCanCancel: true,
  parentCanCancel: true,
};
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof AppError ? e.code : 'other';
  }
};

describe('cancel rules (5.7.1)', () => {
  it('CNL-01: the reason is mandatory and limited', () => {
    expect(normalizeCancelReason('  Заболел  ')).toBe('Заболел');
    expect(code(() => normalizeCancelReason('   '))).toBe('CANCEL_REASON_REQUIRED');
    expect(code(() => normalizeCancelReason(null))).toBe('CANCEL_REASON_REQUIRED');
    expect(code(() => normalizeCancelReason('x'.repeat(501)))).toBe('VALIDATION_ERROR');
  });

  it('CNL-06: late when fewer than the threshold hours remain', () => {
    expect(isLateCancel(lesson('2026-10-21T09:59:00Z'), 24, now)).toBe(true);
    expect(isLateCancel(lesson('2026-10-21T10:00:00Z'), 24, now)).toBe(false);
    expect(isLateCancel(lesson('2026-10-20T09:00:00Z'), 0, now)).toBe(false); // threshold 0: never late
  });

  it('CNL-02: the teacher cancels until the end, even a started lesson', () => {
    expect(checkCancel({ role: 'TEACHER', lesson: lesson('2026-10-20T09:30:00Z'), profile, now })).toEqual({
      outcome: 'cancel',
      isLate: true,
    });
    expect(
      code(() => checkCancel({ role: 'TEACHER', lesson: lesson('2026-10-20T08:00:00Z'), profile, now })),
    ).toBe('CONFLICT');
    expect(
      code(() =>
        checkCancel({
          role: 'TEACHER',
          lesson: lesson('2026-10-22T08:00:00Z', null, 'cancelled' as never),
          profile,
          now,
        }),
      ),
    ).toBe('CONFLICT');
  });

  it('CNL-02 / CNL-03: a student cancels an individual lesson before its start and reports absence from a group one', () => {
    expect(checkCancel({ role: 'STUDENT', lesson: lesson('2026-10-22T10:00:00Z'), profile, now })).toEqual({
      outcome: 'cancel',
      isLate: false,
    });
    expect(
      checkCancel({ role: 'PARENT', lesson: lesson('2026-10-20T20:00:00Z', 'g1'), profile, now }),
    ).toEqual({
      outcome: 'absence',
      isLate: true,
    });
    expect(
      code(() => checkCancel({ role: 'STUDENT', lesson: lesson('2026-10-20T10:00:00Z'), profile, now })),
    ).toBe('LESSON_STARTED');
  });

  it('CNL-02: switches per role; CNL-07: cutoff hours', () => {
    const off = { ...profile, studentCanCancel: false };
    expect(
      code(() => checkCancel({ role: 'STUDENT', lesson: lesson('2026-10-22T10:00:00Z'), profile: off, now })),
    ).toBe('CANCEL_DISABLED');
    expect(
      checkCancel({ role: 'PARENT', lesson: lesson('2026-10-22T10:00:00Z'), profile: off, now }).outcome,
    ).toBe('cancel');
    const cutoff = { ...profile, studentCancelCutoffHours: 12 };
    expect(
      code(() =>
        checkCancel({ role: 'PARENT', lesson: lesson('2026-10-20T21:59:00Z'), profile: cutoff, now }),
      ),
    ).toBe('CANCEL_CUTOFF');
    expect(
      checkCancel({ role: 'PARENT', lesson: lesson('2026-10-20T22:00:00Z'), profile: cutoff, now }).isLate,
    ).toBe(true);
  });
});
