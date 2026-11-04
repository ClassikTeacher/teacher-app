import { percentOf, round2, weightedAverage } from './gradebook.rules.js';

/** What the statistics need of an entry: pure data, ordered by (date, createdAt) ascending by the caller. */
export interface ScoredEntry {
  id: string;
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  value: number;
  max: number | null;
  weight: number;
  category?: string | null;
  testKindId?: string | null;
  scaleValueId?: string | null;
}

export interface Range {
  /** ISO dates, inclusive. */
  from: string;
  to: string;
}

export function inRange(entry: Pick<ScoredEntry, 'date'>, range: Range | null): boolean {
  return !range || (entry.date >= range.from && entry.date <= range.to);
}

/** 5.11.2: the weighted average of school marks over a period (💡 all weights 1 unless changed). */
export interface SchoolStats {
  count: number;
  average: number | null;
  /** Average per category for the same period. */
  byCategory: Array<{ category: string; count: number; average: number | null }>;
}

export function schoolStats(entries: readonly ScoredEntry[], range: Range | null): SchoolStats {
  const period = entries.filter((e) => inRange(e, range));
  const categories = new Map<string, ScoredEntry[]>();
  for (const e of period) {
    const key = e.category ?? 'current';
    categories.set(key, [...(categories.get(key) ?? []), e]);
  }
  return {
    count: period.length,
    average: weightedAverage(period),
    byCategory: [...categories.entries()].map(([category, list]) => ({
      category,
      count: list.length,
      average: weightedAverage(list),
    })),
  };
}

/** 5.11.3: dynamics of test results; every figure is in percent so different maxima compare. */
export interface TestStats {
  count: number;
  /** The latest result in percent and raw. */
  last: { id: string; date: string; percent: number; value: number; max: number } | null;
  /** Change of the latest result against the previous one, in percentage points. */
  delta: number | null;
  best: { id: string; date: string; percent: number } | null;
  /** Average percent over the period. */
  average: number | null;
  /** Distance from the latest result to the target line, in percentage points (💡 target). */
  toTarget: number | null;
}

export function testStats(
  entries: readonly ScoredEntry[],
  range: Range | null,
  targetPercent: number | null,
): TestStats {
  const scored = entries
    .filter((e) => e.max !== null && inRange(e, range))
    .map((e) => ({ ...e, percent: percentOf(e.value, e.max)! }));
  const last = scored.at(-1) ?? null;
  const previous = scored.at(-2) ?? null;
  const best = scored.reduce<(typeof scored)[number] | null>(
    (acc, e) => (acc === null || e.percent > acc.percent ? e : acc),
    null,
  );
  return {
    count: scored.length,
    last: last
      ? { id: last.id, date: last.date, percent: last.percent, value: last.value, max: last.max! }
      : null,
    delta: last && previous ? round2(last.percent - previous.percent) : null,
    best: best ? { id: best.id, date: best.date, percent: best.percent } : null,
    average: scored.length > 0 ? round2(scored.reduce((s, e) => s + e.percent, 0) / scored.length) : null,
    toTarget: last && targetPercent !== null ? round2(last.percent - targetPercent) : null,
  };
}

/** Per-entry change against the previous test, for the ▲ +7 / ▼ −3 list (5.11.3). */
export function testDeltas(entries: readonly ScoredEntry[]): Map<string, number | null> {
  const out = new Map<string, number | null>();
  let previous: number | null = null;
  for (const e of entries) {
    const percent = percentOf(e.value, e.max);
    if (percent === null) continue;
    out.set(e.id, previous === null ? null : round2(percent - previous));
    previous = percent;
  }
  return out;
}

/** 5.11.4: how many times each value was received over the period. */
export interface CustomStats {
  count: number;
  byValue: Array<{ scaleValueId: string; count: number }>;
  /** Weighted average when the scale values carry weights. */
  average: number | null;
}

export function customStats(
  entries: readonly ScoredEntry[],
  range: Range | null,
  weights: ReadonlyMap<string, number | null>,
): CustomStats {
  const period = entries.filter((e) => e.scaleValueId && inRange(e, range));
  const counts = new Map<string, number>();
  for (const e of period) counts.set(e.scaleValueId!, (counts.get(e.scaleValueId!) ?? 0) + 1);
  const weighted = period.flatMap((e) => {
    const w = weights.get(e.scaleValueId!);
    return w === null || w === undefined ? [] : [{ value: w, weight: e.weight }];
  });
  return {
    count: period.length,
    byValue: [...counts.entries()].map(([scaleValueId, count]) => ({ scaleValueId, count })),
    average: weighted.length > 0 ? weightedAverage(weighted) : null,
  };
}
