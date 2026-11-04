import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import {
  MAX_SCALE_LABEL_LENGTH,
  MAX_SCALE_VALUES,
  MAX_TEST_KIND_NAME_LENGTH,
  MIN_SCALE_VALUES,
  type ScaleValueInput,
} from '@modules/gradebook/gradebook.rules.js';
import { JournalsUseCase } from '@modules/gradebook/journals.use-case.js';
import type { BotContext } from '../../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../../core/flow.js';
import { escapeHtml, renderMenu, say } from '../../core/ui.js';
import { isTerminalFlowError } from '../common/flow-errors.js';
import { sectionCb } from '../section-module.js';

export type JournalTextKind = 'target' | 'test-kind' | 'scale';

export interface JournalTextPreset {
  kind: JournalTextKind;
  /** `target`: the journal. */
  journalId?: string;
}

export interface JournalTextData extends Record<string, unknown>, JournalTextPreset {
  text: string;
}

/**
 * One typed value for the gradebook settings: the target percent of a tests journal (💡 5.11.3), a new test
 * kind, or the whole custom scale as lines «эмодзи подпись [=вес]» (5.11.4). The use-case validates again.
 */
@Injectable()
export class JournalTextFlow extends Flow<JournalTextData> {
  readonly name = 'journal-text';
  readonly firstStep = 'value';

  constructor(private readonly journals: JournalsUseCase) {
    super();
  }

  async initial(_ctx: BotContext, arg: unknown): Promise<JournalTextData> {
    return { ...(arg as JournalTextPreset), text: '' };
  }

  private back(d: JournalTextData): string {
    if (d.kind === 'target' && d.journalId) return sectionCb('journals', 'j', d.journalId);
    return sectionCb('journals', d.kind === 'scale' ? 'scale' : 'kinds');
  }

  private async cancel(ctx: BotContext, d: JournalTextData): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(ctx, ctx.t('cancel-done'), new InlineKeyboard().text(ctx.t('btn-back'), this.back(d)));
    return { stay: true };
  }

  readonly steps: Record<string, FlowStep<JournalTextData>> = {
    value: {
      enter: async (ctx, d) => {
        const kb = new InlineKeyboard();
        if (d.kind === 'target') kb.text(ctx.t('btn-target-clear'), flowCb('value', 'clear'));
        kb.text(ctx.t('btn-cancel'), flowCb('value', 'cancel'));
        const key = {
          target: 'journal-ask-target',
          'test-kind': 'journal-ask-kind',
          scale: 'journal-ask-scale',
        }[d.kind];
        await renderMenu(ctx, ctx.t(key, { min: MIN_SCALE_VALUES, max: MAX_SCALE_VALUES }), kb);
      },
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.cancel(ctx, d);
        if (action === 'clear' && d.kind === 'target') {
          d.text = '';
          return { done: true };
        }
        return { stay: true };
      },
      onText: async (ctx, d, text) => {
        if (d.kind === 'test-kind' && text.length > MAX_TEST_KIND_NAME_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_TEST_KIND_NAME_LENGTH }));
          return { stay: true };
        }
        if (d.kind === 'target' && !/^\d{1,3}$/.test(text.trim())) {
          await say(ctx, ctx.t('journal-target-invalid'));
          return { stay: true };
        }
        d.text = text.trim();
        return { done: true };
      },
    },
  };

  async complete(ctx: BotContext, d: JournalTextData): Promise<void | { goto: string }> {
    if (!ctx.actor) return;
    const actor = ctx.actor.actor;
    const back = new InlineKeyboard().text(ctx.t('btn-back'), this.back(d));
    try {
      if (d.kind === 'target' && d.journalId) {
        await this.journals.updateSettings(actor, d.journalId, {
          targetPercent: d.text ? Number(d.text) : null,
        });
        await renderMenu(
          ctx,
          ctx.t(d.text ? 'journal-target-set' : 'journal-target-cleared', { value: d.text }),
          back,
        );
        return;
      }
      if (d.kind === 'test-kind') {
        const row = await this.journals.addTestKind(actor, d.text);
        await renderMenu(ctx, ctx.t('journal-kind-added', { name: escapeHtml(row.name) }), back);
        return;
      }
      const view = await this.journals.putCustomScale(actor, { values: parseScaleLines(d.text) });
      await renderMenu(
        ctx,
        ctx.t('journal-scale-saved', { count: view.values.filter((v) => !v.archivedAt).length }),
        back,
      );
    } catch (error) {
      if (AppError.is(error, 'CONFLICT')) {
        await renderMenu(ctx, ctx.t('journal-kind-exists'), back);
        return;
      }
      if (AppError.is(error, 'VALIDATION_ERROR')) {
        await say(
          ctx,
          ctx.t(d.kind === 'scale' ? 'journal-scale-invalid' : 'journal-target-invalid', {
            min: MIN_SCALE_VALUES,
            max: MAX_SCALE_VALUES,
            label: MAX_SCALE_LABEL_LENGTH,
          }),
        );
        return { goto: 'value' };
      }
      if (isTerminalFlowError(error)) ctx.session.flow = undefined;
      throw error;
    }
  }
}

const WEIGHT = /\s*=\s*(\d+(?:[.,]\d+)?)\s*$/;

/**
 * «⭐ Отлично = 3» per line → scale values: the weight is cut off the end first, then the first token is the
 * emoji only when it has no letters or digits («Очень хорошо», «5 баллов» stay whole labels).
 */
export function parseScaleLines(text: string): ScaleValueInput[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const w = WEIGHT.exec(line);
      const weight = w ? Number(w[1]!.replace(',', '.')) : null;
      const body = (w ? line.slice(0, w.index) : line).trim();
      const space = body.search(/\s/);
      const first = space > 0 ? body.slice(0, space) : null;
      const emoji = first && !/\p{L}|\p{N}/u.test(first) ? first : null;
      const label = emoji ? body.slice(space).trim() : body;
      return { label, emoji, weight };
    });
}
