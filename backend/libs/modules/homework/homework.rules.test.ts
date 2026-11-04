import { describe, expect, it } from 'vitest';
import { assertCanSubmit, DEFAULT_RULES, dueFor, isLate, normalizeRules } from './homework.rules.js';

const at = new Date('2026-11-05T10:00:00Z');
const due = new Date('2026-11-05T09:00:00Z');
const ok = { fileCount: 1, hasText: false };
const err = (reason: string): unknown =>
  expect.objectContaining({ details: expect.objectContaining({ reason }) });

describe('homework rules (5.10.1, 5.10.2)', () => {
  it('computes the due date per mode: fixed, next lesson of the student, none', () => {
    expect(dueFor('fixed', due, null)).toEqual({ dueAt: due, dueLessonId: null });
    const lesson = { id: 'l1', startsAt: new Date('2026-11-07T10:00:00Z') };
    expect(dueFor('next_lesson', null, lesson)).toEqual({ dueAt: lesson.startsAt, dueLessonId: 'l1' });
    expect(dueFor('next_lesson', null, null)).toEqual({ dueAt: null, dueLessonId: null });
    expect(dueFor('none', due, lesson)).toEqual({ dueAt: null, dueLessonId: null });
    expect(isLate(due, at)).toBe(true);
    expect(isLate(null, at)).toBe(false);
  });

  it('refuses late work when the rule forbids it, and a second attempt without resubmission', () => {
    expect(() => assertCanSubmit('assigned', 1, 'files', DEFAULT_RULES, due, at, ok)).not.toThrow();
    const noLate = { ...DEFAULT_RULES, acceptLate: false };
    expect(() => assertCanSubmit('overdue', 1, 'files', noLate, due, at, ok)).toThrow(err('late_forbidden'));
    expect(() => assertCanSubmit('submitted', 2, 'files', DEFAULT_RULES, null, at, ok)).toThrow(
      err('status_submitted'),
    );
    const noResubmit = { ...DEFAULT_RULES, allowResubmit: false };
    expect(() => assertCanSubmit('accepted', 2, 'files', noResubmit, null, at, ok)).toThrow();
    // returned work may always come back, even when resubmission is off
    expect(() => assertCanSubmit('returned', 2, 'files', noResubmit, null, at, ok)).not.toThrow();
  });

  it('checks the submission against the mode and the file limit', () => {
    const textOnly = { fileCount: 0, hasText: true };
    expect(() => assertCanSubmit('assigned', 1, 'files', DEFAULT_RULES, null, at, textOnly)).toThrow(
      err('files_required'),
    );
    const both = { fileCount: 1, hasText: true };
    expect(() => assertCanSubmit('assigned', 1, 'text', DEFAULT_RULES, null, at, both)).toThrow(
      err('text_only'),
    );
    const two = { ...DEFAULT_RULES, maxFiles: 2 };
    const three = { fileCount: 3, hasText: false };
    expect(() => assertCanSubmit('assigned', 1, 'files_text', two, null, at, three)).toThrow(
      err('too_many_files'),
    );
    const nothing = { fileCount: 0, hasText: false };
    expect(() => assertCanSubmit('assigned', 1, 'mark', DEFAULT_RULES, null, at, nothing)).not.toThrow();
    expect(() => assertCanSubmit('assigned', 1, 'none', DEFAULT_RULES, null, at, nothing)).toThrow(
      err('no_submission'),
    );
    expect(() => assertCanSubmit('assigned', 1, 'files_text', DEFAULT_RULES, null, at, nothing)).toThrow(
      err('empty'),
    );
  });

  it('normalises rules: subset of the platform list, bounded maxFiles, defaults', () => {
    const platform = ['pdf', 'jpg', 'png'];
    expect(normalizeRules(undefined, platform)).toEqual({
      maxFiles: 10,
      allowResubmit: true,
      acceptLate: true,
    });
    expect(normalizeRules({ allowedExts: ['PDF', 'exe'], maxFiles: 3, acceptLate: false }, platform)).toEqual(
      {
        allowedExts: ['pdf'],
        maxFiles: 3,
        allowResubmit: true,
        acceptLate: false,
      },
    );
    expect(() => normalizeRules({ allowedExts: ['exe'] }, platform)).toThrow();
    expect(() => normalizeRules({ maxFiles: 0 }, platform)).toThrow();
  });
});
