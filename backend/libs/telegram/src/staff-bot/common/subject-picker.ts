import { InlineKeyboard } from 'grammy';
import type { SubjectRow } from '@modules/people/schema.js';
import type { BotContext } from '../../core/context.js';

import { resolveRef, shortRef } from './short-ref.js';

/** Reference to a catalogue entry that fits a 64-byte callback: index plus id suffix (see short-ref.ts). */
export function subjectRef(subjects: readonly SubjectRow[], index: number): [number, string] {
  return shortRef(subjects[index]!.id, index);
}

/** Resolves a reference from a pressed button; null when the catalogue changed since the screen was drawn. */
export function subjectByRef(
  subjects: readonly SubjectRow[],
  index: string | undefined,
  check: string | undefined,
): SubjectRow | null {
  return resolveRef(subjects, index, check, (s) => s.id);
}

/**
 * Multi-select list of subjects shared by the student card and the teacher settings: ✅ marks the selected
 * ones, `payload` builds the callback of each row, `back` is the payload of the back button.
 */
export function subjectPickerKeyboard(
  ctx: BotContext,
  subjects: readonly SubjectRow[],
  selected: readonly string[],
  payload: (subject: SubjectRow, index: number) => string,
  back: string,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  subjects.forEach((subject, index) => {
    const mark = selected.includes(subject.id) ? '✅ ' : '';
    kb.text(`${mark}${subject.name}`, payload(subject, index)).row();
  });
  kb.text(ctx.t('btn-back'), back);
  return kb;
}
