import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { DateTime } from 'luxon';
import { MaterialsUseCase, MAX_TITLE_LENGTH } from '@modules/content/materials.use-case.js';
import type { BotContext } from '../../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../../core/flow.js';
import { escapeHtml, renderMenu, say } from '../../core/ui.js';
import { isTerminalFlowError } from '../common/flow-errors.js';
import { sectionCb } from '../section-module.js';

export interface CreateCollectionData extends Record<string, unknown> {
  title: string | null;
  periodFrom: string | null;
  periodTo: string | null;
}

const PERIOD = /^(\d{2}\.\d{2}\.\d{4})\s*[-–—]\s*(\d{2}\.\d{2}\.\d{4})$/;
const DATE_FORMAT = 'dd.MM.yyyy';

/** 5.9.2: a flat collection with an optional period («Материалы за ноябрь»). */
@Injectable()
export class CreateCollectionFlow extends Flow<CreateCollectionData> {
  readonly name = 'create-collection';
  readonly firstStep = 'title';

  constructor(private readonly materials: MaterialsUseCase) {
    super();
  }

  async initial(): Promise<CreateCollectionData> {
    return { title: null, periodFrom: null, periodTo: null };
  }

  private async cancel(ctx: BotContext): Promise<FlowNext> {
    ctx.session.flow = undefined;
    const back = new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('materials', 'cols'));
    await renderMenu(ctx, ctx.t('cancel-done'), back);
    return { stay: true };
  }

  readonly steps: Record<string, FlowStep<CreateCollectionData>> = {
    title: {
      enter: async (ctx) =>
        renderMenu(
          ctx,
          ctx.t('newcol-ask-title'),
          new InlineKeyboard().text(ctx.t('btn-cancel'), flowCb('title', 'cancel')),
        ),
      onCallback: async (ctx, _d, action) => (action === 'cancel' ? this.cancel(ctx) : { stay: true }),
      onText: async (ctx, d, text) => {
        if (!text || text.length > MAX_TITLE_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_TITLE_LENGTH }));
          return { stay: true };
        }
        d.title = text;
        return { goto: 'period' };
      },
    },
    period: {
      enter: async (ctx) =>
        renderMenu(
          ctx,
          ctx.t('newcol-ask-period'),
          new InlineKeyboard()
            .text(ctx.t('btn-skip'), flowCb('period', 'skip'))
            .text(ctx.t('btn-cancel'), flowCb('period', 'cancel')),
        ),
      onCallback: async (ctx, _d, action) => {
        if (action === 'cancel') return this.cancel(ctx);
        return action === 'skip' ? { done: true } : { stay: true };
      },
      onText: async (ctx, d, text) => {
        const m = PERIOD.exec(text.trim());
        const from = m ? DateTime.fromFormat(m[1]!, DATE_FORMAT) : null;
        const to = m ? DateTime.fromFormat(m[2]!, DATE_FORMAT) : null;
        if (!from?.isValid || !to?.isValid || from > to) {
          await say(ctx, ctx.t('newcol-bad-period'));
          return { stay: true };
        }
        d.periodFrom = from.toISODate();
        d.periodTo = to.toISODate();
        return { done: true };
      },
    },
  };

  async complete(ctx: BotContext, d: CreateCollectionData): Promise<void> {
    if (!ctx.actor || !d.title) {
      ctx.session.flow = undefined;
      return;
    }
    try {
      const row = await this.materials.createCollection(ctx.actor.actor, {
        title: d.title,
        periodFrom: d.periodFrom,
        periodTo: d.periodTo,
      });
      await renderMenu(
        ctx,
        ctx.t('newcol-done', { title: escapeHtml(row.title) }),
        new InlineKeyboard().text(ctx.t('btn-open'), sectionCb('materials', 'col', row.id)),
      );
    } catch (error) {
      if (isTerminalFlowError(error)) ctx.session.flow = undefined;
      throw error;
    }
  }
}
