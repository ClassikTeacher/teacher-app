import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { Clock } from '@shared/time/clock.js';
import { SeriesUseCase } from '@modules/schedule/series/series.use-case.js';
import type { BotContext } from '../../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../../core/flow.js';
import { renderMenu, say } from '../../core/ui.js';
import { isTerminalFlowError } from '../common/flow-errors.js';
import { sectionCb } from '../section-module.js';
import { zoneOf } from './day-picker.js';
import { fmtDay, parseDayInput } from './time-input.js';

export interface PauseSeriesData extends Record<string, unknown> {
  seriesId: string;
  from: string;
  to: string;
}

/** 5.5.6 "Пауза серии на период": from → to (inclusive) → pause. */
@Injectable()
export class PauseSeriesFlow extends Flow<PauseSeriesData> {
  readonly name = 'pause-series';
  readonly firstStep = 'from';

  constructor(
    private readonly series: SeriesUseCase,
    private readonly clock: Clock,
  ) {
    super();
  }

  async initial(_ctx: BotContext, arg: unknown): Promise<PauseSeriesData> {
    return { seriesId: (arg as { seriesId: string }).seriesId, from: '', to: '' };
  }

  private async cancel(ctx: BotContext, d: PauseSeriesData): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(ctx, ctx.t('cancel-done'), this.back(ctx, d));
    return { stay: true };
  }

  private back(ctx: BotContext, d: PauseSeriesData): InlineKeyboard {
    return new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('today', 'scard', d.seriesId));
  }

  readonly steps: Record<string, FlowStep<PauseSeriesData>> = {
    from: {
      enter: async (ctx) =>
        renderMenu(
          ctx,
          ctx.t('series-pause-from'),
          new InlineKeyboard().text(ctx.t('btn-cancel'), flowCb('from', 'cancel')),
        ),
      onCallback: async (ctx, d, action) => (action === 'cancel' ? this.cancel(ctx, d) : { stay: true }),
      onText: async (ctx, d, text) => {
        const iso = parseDayInput(text, zoneOf(ctx), this.clock.now());
        if (!iso) {
          await say(ctx, ctx.t('day-invalid'));
          return { stay: true };
        }
        d.from = iso;
        return { goto: 'to' };
      },
    },
    to: {
      enter: async (ctx) =>
        renderMenu(
          ctx,
          ctx.t('series-pause-to'),
          new InlineKeyboard().text(ctx.t('btn-cancel'), flowCb('to', 'cancel')),
        ),
      onCallback: async (ctx, d, action) => (action === 'cancel' ? this.cancel(ctx, d) : { stay: true }),
      onText: async (ctx, d, text) => {
        const iso = parseDayInput(text, zoneOf(ctx), this.clock.now());
        if (!iso || iso < d.from) {
          await say(ctx, ctx.t('day-invalid'));
          return { stay: true };
        }
        d.to = iso;
        return { done: true };
      },
    },
  };

  async complete(ctx: BotContext, d: PauseSeriesData): Promise<void> {
    if (!ctx.actor) {
      ctx.session.flow = undefined;
      return;
    }
    try {
      await this.series.pause(ctx.actor.actor, d.seriesId, d.from, d.to);
    } catch (error) {
      if (isTerminalFlowError(error)) ctx.session.flow = undefined;
      throw error;
    }
    const zone = zoneOf(ctx);
    await renderMenu(
      ctx,
      ctx.t('series-paused', { from: fmtDay(d.from, zone), to: fmtDay(d.to, zone) }),
      this.back(ctx, d),
    );
  }
}
