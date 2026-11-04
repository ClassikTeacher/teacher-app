import { describe, expect, it } from 'vitest';
import { AppError } from '@shared/errors/app-error.js';
import {
  normalizeEmoji,
  normalizeEntryDate,
  normalizeScaleValues,
  normalizeSchoolValue,
  normalizeTestScore,
  percentOf,
  weightedAverage,
} from './gradebook.rules.js';
import { customStats, schoolStats, testDeltas, testStats } from './stats.js';
import { parseScaleLines } from '../../telegram/src/staff-bot/journals/journal-text.flow.js';

describe('custom scale text input (review H2)', () => {
  it('keeps multi-word labels whole, reads the weight, takes only a symbol as the emoji', () => {
    expect(
      parseScaleLines('⭐ Отлично = 3\n👍 Хорошо = 2\n💪 Старайся\nОчень хорошо\n5 баллов\n10 = 2'),
    ).toEqual([
      { label: 'Отлично', emoji: '⭐', weight: 3 },
      { label: 'Хорошо', emoji: '👍', weight: 2 },
      { label: 'Старайся', emoji: '💪', weight: null },
      { label: 'Очень хорошо', emoji: null, weight: null },
      { label: '5 баллов', emoji: null, weight: null },
      { label: '10', emoji: null, weight: 2 },
    ]);
  });
});

const ten = { minValue: 1, maxValue: 10 };

describe('gradebook rules (5.11)', () => {
  it('accepts integer school marks inside the scale and rejects the rest', () => {
    expect(normalizeSchoolValue(ten, 8)).toBe(8);
    for (const bad of [0, 11, 7.5, Number.NaN]) {
      expect(() => normalizeSchoolValue(ten, bad)).toThrow(AppError);
    }
  });

  it('normalises test scores with a default maximum of 100 and optional parts', () => {
    expect(normalizeTestScore({ value: 73 })).toEqual({ value: 73, max: 100, parts: null });
    expect(normalizeTestScore({ value: 45, max: 60, parts: { a: 30, b: 15 } })).toEqual({
      value: 45,
      max: 60,
      parts: { a: 30, b: 15 },
    });
    expect(() => normalizeTestScore({ value: 101 })).toThrow(AppError);
    expect(() => normalizeTestScore({ value: 10, max: 0 })).toThrow(AppError);
    expect(() => normalizeTestScore({ value: 50, max: 60, parts: { a: 50, b: 20 } })).toThrow(AppError);
  });

  it('accepts a calendar date up to today only', () => {
    expect(normalizeEntryDate('2026-11-03', '2026-11-04')).toBe('2026-11-03');
    expect(() => normalizeEntryDate('2026-11-05', '2026-11-04')).toThrow(AppError);
    expect(() => normalizeEntryDate('2026-13-01', '2026-11-04')).toThrow(AppError);
    expect(() => normalizeEntryDate('03.11.2026', '2026-11-04')).toThrow(AppError);
  });

  it('validates custom scale values: 2–10, unique labels, single-grapheme emoji (JRN-06 groundwork)', () => {
    expect(normalizeScaleValues([{ label: 'Отлично', emoji: '⭐' }, { label: 'Хорошо' }])).toEqual([
      { label: 'Отлично', emoji: '⭐', weight: null },
      { label: 'Хорошо', emoji: null, weight: null },
    ]);
    expect(() => normalizeScaleValues([{ label: 'Одно' }])).toThrow(AppError);
    expect(() => normalizeScaleValues(Array.from({ length: 11 }, (_, i) => ({ label: `v${i}` })))).toThrow(
      AppError,
    );
    expect(() => normalizeScaleValues([{ label: 'A' }, { label: 'a' }])).toThrow(AppError);
    expect(normalizeEmoji('👨‍👩‍👧')).toBe('👨‍👩‍👧');
    expect(() => normalizeEmoji('ab')).toThrow(AppError);
    expect(() => normalizeEmoji('⭐⭐')).toThrow(AppError);
  });

  it('computes weighted averages and percentages', () => {
    expect(weightedAverage([])).toBeNull();
    expect(
      weightedAverage([
        { value: 8, weight: 1 },
        { value: 6, weight: 1 },
      ]),
    ).toBe(7);
    expect(
      weightedAverage([
        { value: 8, weight: 1 },
        { value: 4, weight: 3 },
      ]),
    ).toBe(5);
    expect(percentOf(45, 60)).toBe(75);
    expect(percentOf(1, 3)).toBe(33.3);
    expect(percentOf(5, null)).toBeNull();
  });
});

describe('journal statistics (M6-02)', () => {
  const school = [
    { id: 'a', date: '2026-10-05', value: 8, max: null, weight: 1, category: 'current' },
    { id: 'b', date: '2026-10-20', value: 6, max: null, weight: 1, category: 'control' },
    { id: 'c', date: '2026-11-02', value: 10, max: null, weight: 2, category: 'control' },
  ];

  it('averages school marks over a period with category weights', () => {
    const all = schoolStats(school, null);
    expect(all.count).toBe(3);
    expect(all.average).toBe(8.5); // (8 + 6 + 20) / 4
    expect(all.byCategory).toEqual([
      { category: 'current', count: 1, average: 8 },
      { category: 'control', count: 2, average: 8.67 },
    ]);
    const october = schoolStats(school, { from: '2026-10-01', to: '2026-10-31' });
    expect(october).toMatchObject({ count: 2, average: 7 });
    expect(schoolStats(school, { from: '2027-01-01', to: '2027-01-31' })).toMatchObject({
      count: 0,
      average: null,
    });
  });

  const tests = [
    { id: 't1', date: '2026-09-10', value: 60, max: 100, weight: 1 },
    { id: 't2', date: '2026-10-10', value: 42, max: 60, weight: 1 }, // 70 %
    { id: 't3', date: '2026-11-01', value: 65, max: 100, weight: 1 },
  ];

  it('compares tests in percent: last, delta, best, average, distance to the target', () => {
    const s = testStats(tests, null, 80);
    expect(s.count).toBe(3);
    expect(s.last).toEqual({ id: 't3', date: '2026-11-01', percent: 65, value: 65, max: 100 });
    expect(s.delta).toBe(-5);
    expect(s.best).toEqual({ id: 't2', date: '2026-10-10', percent: 70 });
    expect(s.average).toBe(65);
    expect(s.toTarget).toBe(-15);
    expect(testDeltas(tests)).toEqual(
      new Map([
        ['t1', null],
        ['t2', 10],
        ['t3', -5],
      ]),
    );
    expect(testStats([], null, null)).toMatchObject({ count: 0, last: null, delta: null, best: null });
  });

  it('counts custom values and averages their weights when given', () => {
    const entries = [
      { id: 'c1', date: '2026-10-01', value: 0, max: null, weight: 1, scaleValueId: 'star' },
      { id: 'c2', date: '2026-10-02', value: 0, max: null, weight: 1, scaleValueId: 'star' },
      { id: 'c3', date: '2026-10-03', value: 0, max: null, weight: 1, scaleValueId: 'ok' },
    ];
    const weights = new Map<string, number | null>([
      ['star', 2],
      ['ok', 1],
    ]);
    expect(customStats(entries, null, weights)).toEqual({
      count: 3,
      byValue: [
        { scaleValueId: 'star', count: 2 },
        { scaleValueId: 'ok', count: 1 },
      ],
      average: 1.67,
    });
    expect(customStats(entries, null, new Map()).average).toBeNull();
  });
});
