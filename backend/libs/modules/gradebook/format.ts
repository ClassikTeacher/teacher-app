import { percentOf, scaleValueLabel } from './gradebook.rules.js';
import type { GradeEntryRow, GradeScaleValueRow, JournalType, TestKindRow } from './schema.js';

/** Lookups a screen needs to print values: custom scale values and test kinds by id. */
export interface EntryLookups {
  scaleValues: ReadonlyMap<string, Pick<GradeScaleValueRow, 'label' | 'emoji'>>;
  testKinds: ReadonlyMap<string, Pick<TestKindRow, 'name'>>;
}

/** Plain-text value of a record: "8", "73/100 (73 %)" or "⭐ Отлично". Escape before HTML use. */
export function entryValueText(entry: GradeEntryRow, type: JournalType, lookups: EntryLookups): string {
  if (type === 'custom') {
    const value = entry.scaleValueId ? lookups.scaleValues.get(entry.scaleValueId) : null;
    return value ? scaleValueLabel(value) : '—';
  }
  if (type === 'tests') {
    const value = entry.valueNumeric ?? 0;
    const percent = percentOf(value, entry.valueMax);
    return `${trim(value)}/${trim(entry.valueMax ?? 0)}${percent === null ? '' : ` (${trim(percent)} %)`}`;
  }
  return trim(entry.valueNumeric ?? 0);
}

/** The kind of a test record, or the school category key for i18n (`grade-category-<key>`). */
export function entryKindText(entry: GradeEntryRow, type: JournalType, lookups: EntryLookups): string | null {
  if (type === 'tests')
    return entry.testKindId ? (lookups.testKinds.get(entry.testKindId)?.name ?? null) : null;
  if (type === 'school') return entry.category;
  return null;
}

/** ▲ +7 / ▼ −3 / nothing. */
export function deltaMark(delta: number | null | undefined): string {
  if (delta === null || delta === undefined || delta === 0) return '';
  return delta > 0 ? `▲ +${trim(delta)}` : `▼ −${trim(Math.abs(delta))}`;
}

/** Numbers without trailing zeros: 8, 7.5, 73. */
export function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}
