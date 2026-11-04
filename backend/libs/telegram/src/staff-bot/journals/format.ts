import { DateTime } from 'luxon';
import { deltaMark, entryKindText, entryValueText, trim } from '@modules/gradebook/format.js';
import { scaleValueLabel } from '@modules/gradebook/gradebook.rules.js';
import type { JournalCard } from '@modules/gradebook/gradebook.query.js';
import type { GradeEntryRow } from '@modules/gradebook/schema.js';
import type { BotContext } from '../../core/context.js';
import { escapeHtml } from '../../core/ui.js';

const DATE = 'dd.MM';

/** One record as a line of the journal screen (HTML): «03.11 · 8 · контрольная · комментарий». */
export function entryLine(ctx: BotContext, card: JournalCard, entry: GradeEntryRow): string {
  const value = escapeHtml(entryValueText(entry, card.journal.type, card.lookups));
  const kindRaw = entryKindText(entry, card.journal.type, card.lookups);
  const kind =
    card.journal.type === 'school'
      ? ctx.t('grade-category', { key: kindRaw ?? 'current' })
      : escapeHtml(kindRaw ?? '');
  const parts: string[] = [DateTime.fromISO(entry.date).toFormat(DATE), `<b>${value}</b>`];
  if (card.journal.type === 'tests') {
    const mark = deltaMark(card.deltas.get(entry.id));
    if (mark) parts.push(mark);
  }
  if (kind) parts.push(kind);
  if (entry.source !== 'teacher') parts.push(ctx.t('grade-source', { source: entry.source }));
  if (entry.comment) parts.push(escapeHtml(entry.comment));
  return parts.join(' · ');
}

/** Button label of a record (plain text). */
export function entryButton(card: JournalCard, entry: GradeEntryRow): string {
  return `${DateTime.fromISO(entry.date).toFormat(DATE)} · ${entryValueText(entry, card.journal.type, card.lookups)}`;
}

/** The statistics block of a journal screen (HTML), period-aware. */
export function statsText(ctx: BotContext, card: JournalCard): string {
  const { stats } = card;
  if (stats.type === 'school') {
    const s = stats.stats;
    const byCategory = s.byCategory
      .filter((c) => c.average !== null)
      .map((c) => `${ctx.t('grade-category', { key: c.category })}: ${trim(c.average!)}`)
      .join(', ');
    return ctx.t('journal-stats-school', {
      count: s.count,
      average: s.average === null ? '—' : trim(s.average),
      byCategory: byCategory ? `\n${byCategory}` : '',
    });
  }
  if (stats.type === 'tests') {
    const s = stats.stats;
    return ctx.t('journal-stats-tests', {
      count: s.count,
      last: s.last ? `${trim(s.last.value)}/${trim(s.last.max)} (${trim(s.last.percent)} %)` : '—',
      delta: deltaMark(s.delta) || '—',
      best: s.best ? `${trim(s.best.percent)} %` : '—',
      average: s.average === null ? '—' : `${trim(s.average)} %`,
      target: card.journal.targetScore === null ? '—' : `${trim(card.journal.targetScore)} %`,
      toTarget: s.toTarget === null ? '' : ` (${deltaMark(s.toTarget) || '0'})`,
    });
  }
  const s = stats.stats;
  const counts = s.byValue
    .map((v) => {
      const value = card.lookups.scaleValues.get(v.scaleValueId);
      return `${value ? escapeHtml(scaleValueLabel(value)) : '—'} × ${v.count}`;
    })
    .join(', ');
  return ctx.t('journal-stats-custom', {
    count: s.count,
    counts: counts || '—',
    average: s.average === null ? '' : ` · ${ctx.t('journal-avg', { value: trim(s.average) })}`,
  });
}

export function periodLabel(ctx: BotContext, card: JournalCard): string {
  if (!card.range) return ctx.t('journal-period-all');
  return `${DateTime.fromISO(card.range.from).toFormat('dd.MM.yyyy')} — ${DateTime.fromISO(card.range.to).toFormat('dd.MM.yyyy')}`;
}
