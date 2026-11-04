import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import {
  MAX_ALIAS_LENGTH,
  MAX_GOALS_LENGTH,
  MAX_GRADE_LENGTH,
  MAX_MAX_LESSONS_PER_WEEK,
  MAX_NOTES_LENGTH,
  MAX_SCHOOL_LENGTH,
} from '@modules/people/links/link.rules.js';
import {
  type StudentCardPatch,
  UpdateStudentCardUseCase,
} from '@modules/people/links/update-student-card.use-case.js';
import type { BotContext } from '../../core/context.js';
import { Flow, flowCb, type FlowStep } from '../../core/flow.js';
import { renderMenu, say } from '../../core/ui.js';
import { isTerminalFlowError } from '../common/flow-errors.js';
import { sectionCb } from '../section-module.js';

/** Text fields of the card editable one at a time (5.4.1); `limit` is numeric with a "no limit" button. */
export const CARD_TEXT_FIELDS = ['alias', 'grade', 'school', 'goals', 'notes'] as const;
export type CardEditField = (typeof CARD_TEXT_FIELDS)[number] | 'limit';

const TEXT_MAX: Record<(typeof CARD_TEXT_FIELDS)[number], number> = {
  alias: MAX_ALIAS_LENGTH,
  grade: MAX_GRADE_LENGTH,
  school: MAX_SCHOOL_LENGTH,
  goals: MAX_GOALS_LENGTH,
  notes: MAX_NOTES_LENGTH,
};

export interface CardEditData extends Record<string, unknown> {
  linkId: string;
  field: CardEditField;
}

export function isCardEditField(value: string): value is CardEditField {
  return value === 'limit' || (CARD_TEXT_FIELDS as readonly string[]).includes(value);
}

/** One prompt → one answer → PATCH of the card → back to the card screen. */
@Injectable()
export class CardEditFlow extends Flow<CardEditData> {
  readonly name = 'card-edit';
  readonly firstStep = 'value';

  constructor(private readonly update: UpdateStudentCardUseCase) {
    super();
  }

  async initial(_ctx: BotContext, arg: unknown): Promise<CardEditData> {
    return arg as CardEditData;
  }

  readonly steps: Record<string, FlowStep<CardEditData>> = {
    value: {
      enter: async (ctx, d) => {
        const kb = new InlineKeyboard();
        if (d.field === 'limit') kb.text(ctx.t('limit-none'), flowCb('value', 'none'));
        else kb.text(ctx.t('btn-clear-field'), flowCb('value', 'clear'));
        kb.text(ctx.t('btn-cancel'), flowCb('value', 'cancel'));
        await renderMenu(ctx, ctx.t(`card-edit-${d.field}`), kb);
      },
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') {
          ctx.session.flow = undefined;
          await renderMenu(ctx, ctx.t('cancel-done'), this.backToCard(ctx, d));
          return { stay: true };
        }
        if (action === 'none' && d.field === 'limit') return this.save(ctx, d, { maxLessonsPerWeek: null });
        if (action === 'clear' && d.field !== 'limit') return this.save(ctx, d, { [d.field]: null });
        return { stay: true };
      },
      onText: async (ctx, d, text) => {
        if (d.field === 'limit') {
          const n = /^\d{1,2}$/.test(text) ? Number(text) : NaN;
          if (!Number.isInteger(n) || n < 1 || n > MAX_MAX_LESSONS_PER_WEEK) {
            await say(ctx, ctx.t('invite-student-limit-invalid', { max: MAX_MAX_LESSONS_PER_WEEK }));
            return { stay: true };
          }
          return this.save(ctx, d, { maxLessonsPerWeek: n });
        }
        if (!text.trim()) {
          await say(ctx, ctx.t('card-edit-empty'));
          return { stay: true };
        }
        if (text.length > TEXT_MAX[d.field]) {
          await say(ctx, ctx.t('text-too-long', { max: TEXT_MAX[d.field] }));
          return { stay: true };
        }
        return this.save(ctx, d, { [d.field]: text });
      },
    },
  };

  private async save(ctx: BotContext, d: CardEditData, patch: StudentCardPatch) {
    if (!ctx.actor) return { stay: true as const };
    try {
      await this.update.execute(ctx.actor.actor, d.linkId, patch);
    } catch (error) {
      // a card that was closed meanwhile cannot be edited by retyping: leave the dialog, show the error
      if (isTerminalFlowError(error)) ctx.session.flow = undefined;
      throw error;
    }
    ctx.session.flow = undefined;
    await renderMenu(ctx, ctx.t('card-saved'), this.backToCard(ctx, d));
    return { stay: true as const };
  }

  private backToCard(ctx: BotContext, d: CardEditData): InlineKeyboard {
    return new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('students', 'card', d.linkId));
  }

  async complete(): Promise<void> {}
}
