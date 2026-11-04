import { AppError } from '@shared/errors/app-error.js';
import type { FeatureKey } from '@modules/access/features/catalog.js';
import type { GradeScaleRow, GradeScaleValueRow, JournalType, SchoolCategory, TestParts } from './schema.js';

/** 5.11.4: a custom scale has from 2 to 10 values. */
export const MIN_SCALE_VALUES = 2;
export const MAX_SCALE_VALUES = 10;
export const MAX_SCALE_LABEL_LENGTH = 30;
export const MAX_SCALE_TITLE_LENGTH = 60;
export const MAX_ENTRY_COMMENT_LENGTH = 500;
export const MAX_TEST_KIND_NAME_LENGTH = 40;
/** 5.11.3 💡: the default maximum of a test. */
export const DEFAULT_TEST_MAX = 100;
export const MAX_TEST_SCORE = 9999;
export const MAX_ENTRY_WEIGHT = 10;
/** How many pending (student-entered) grades a journal may hold at once — a guard against spam. */
export const MAX_PENDING_PER_JOURNAL = 20;
/** NTF-07 💡: grades beyond this many per day go to the student as one digest. */
export const GRADE_DIGEST_THRESHOLD = 3;

/** The feature flag that governs each journal type (5.3.2). */
export const JOURNAL_FEATURE: Record<JournalType, FeatureKey> = {
  school: 'journal.school',
  tests: 'journal.tests',
  custom: 'journal.custom',
};

export const JOURNAL_ORDER: readonly JournalType[] = ['school', 'tests', 'custom'];

/** School categories with 💡 equal default weights (5.11.2); quarter and year marks are plain labels. */
export const DEFAULT_CATEGORY: SchoolCategory = 'current';

export interface NumericValueInput {
  value: number;
  max?: number | null;
  parts?: TestParts | null;
}

/** A school mark on a numeric scale: an integer inside the scale bounds. */
export function normalizeSchoolValue(
  scale: Pick<GradeScaleRow, 'minValue' | 'maxValue'>,
  value: number,
): number {
  const min = scale.minValue ?? 1;
  const max = scale.maxValue ?? 10;
  if (!Number.isInteger(value) || value < min || value > max)
    throw AppError.validation(`The mark must be an integer between ${min} and ${max}`, {
      reason: 'value_out_of_scale',
      min,
      max,
    });
  return value;
}

/** A test score: 0 ≤ value ≤ max (default 100), optional parts that do not exceed the total. */
export function normalizeTestScore(input: NumericValueInput): {
  value: number;
  max: number;
  parts: TestParts | null;
} {
  const max = input.max ?? DEFAULT_TEST_MAX;
  if (!Number.isFinite(max) || max <= 0 || max > MAX_TEST_SCORE)
    throw AppError.validation('The maximum must be a positive number', { reason: 'max_invalid' });
  const value = input.value;
  if (!Number.isFinite(value) || value < 0 || value > max)
    throw AppError.validation(`The score must be between 0 and ${max}`, {
      reason: 'value_out_of_scale',
      max,
    });
  let parts: TestParts | null = null;
  if (input.parts && (input.parts.a !== undefined || input.parts.b !== undefined)) {
    const a = input.parts.a ?? 0;
    const b = input.parts.b ?? 0;
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0 || a + b > max + 1e-9)
      throw AppError.validation('Parts must be non-negative and not exceed the maximum', {
        reason: 'parts_invalid',
      });
    parts = { a: round2(a), b: round2(b) };
  }
  return { value: round2(value), max: round2(max), parts };
}

export function normalizeWeight(weight: number | null | undefined): number {
  if (weight === null || weight === undefined) return 1;
  if (!Number.isFinite(weight) || weight < 0 || weight > MAX_ENTRY_WEIGHT)
    throw AppError.validation(`The weight must be between 0 and ${MAX_ENTRY_WEIGHT}`, {
      reason: 'weight_invalid',
    });
  return round2(weight);
}

export function normalizeComment(comment: string | null | undefined): string | null {
  const clean = comment?.trim() ?? '';
  if (clean.length > MAX_ENTRY_COMMENT_LENGTH)
    throw AppError.validation('The comment is too long', { max: MAX_ENTRY_COMMENT_LENGTH });
  return clean || null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date `YYYY-MM-DD` that exists and is not in the future relative to `today` (local). */
export function normalizeEntryDate(value: string, today: string): string {
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
    throw AppError.validation('The date must be YYYY-MM-DD', { reason: 'date_invalid' });
  if (value > today) throw AppError.validation('The date cannot be in the future', { reason: 'date_future' });
  return value;
}

export interface ScaleValueInput {
  label: string;
  emoji?: string | null;
  weight?: number | null;
}

/** One grapheme (an emoji with its modifiers), or nothing. */
export function normalizeEmoji(emoji: string | null | undefined): string | null {
  const clean = emoji?.trim() ?? '';
  if (!clean) return null;
  const segments = [...new Intl.Segmenter('ru', { granularity: 'grapheme' }).segment(clean)];
  if (segments.length !== 1 || /\p{L}|\p{N}/u.test(clean))
    throw AppError.validation('The emoji must be a single symbol', { reason: 'emoji_invalid' });
  return clean;
}

/** 5.11.4: 2–10 values, unique labels, optional emoji and weight; order = array order. */
export function normalizeScaleValues(values: readonly ScaleValueInput[]): Array<Required<ScaleValueInput>> {
  if (values.length < MIN_SCALE_VALUES || values.length > MAX_SCALE_VALUES)
    throw AppError.validation(`A scale has ${MIN_SCALE_VALUES} to ${MAX_SCALE_VALUES} values`, {
      reason: 'values_count',
      min: MIN_SCALE_VALUES,
      max: MAX_SCALE_VALUES,
    });
  const seen = new Set<string>();
  return values.map((v) => {
    const label = v.label.trim();
    if (!label || label.length > MAX_SCALE_LABEL_LENGTH)
      throw AppError.validation('A value label is required', {
        reason: 'label_invalid',
        max: MAX_SCALE_LABEL_LENGTH,
      });
    const key = label.toLowerCase();
    if (seen.has(key))
      throw AppError.validation('Value labels must be unique', { reason: 'label_duplicate', label });
    seen.add(key);
    const weight = v.weight === undefined || v.weight === null ? null : normalizeWeight(v.weight);
    return { label, emoji: normalizeEmoji(v.emoji), weight };
  });
}

/** A custom value as shown in texts and buttons: "⭐ Отлично" or just the label. */
export function scaleValueLabel(value: Pick<GradeScaleValueRow, 'label' | 'emoji'>): string {
  return value.emoji ? `${value.emoji} ${value.label}` : value.label;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Percentage of a score against its maximum (tests with different maxima compare in percent, 5.11.3). */
export function percentOf(value: number, max: number | null): number | null {
  if (!max || max <= 0) return null;
  return Math.round((value / max) * 1000) / 10;
}

/** Weighted average over confirmed numeric entries; null without entries or with zero total weight. */
export function weightedAverage(entries: ReadonlyArray<{ value: number; weight: number }>): number | null {
  let sum = 0;
  let weights = 0;
  for (const e of entries) {
    sum += e.value * e.weight;
    weights += e.weight;
  }
  return weights > 0 ? round2(sum / weights) : null;
}
