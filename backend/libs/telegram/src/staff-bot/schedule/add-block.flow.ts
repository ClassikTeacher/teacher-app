import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import {
  MAX_BLOCK_TITLE_LENGTH,
  PersonalBlockUseCase,
} from '@modules/schedule/occupancy/personal-block.use-case.js';
import type { BotContext } from '../../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../../core/flow.js';
import { escapeHtml, renderMenu, say } from '../../core/ui.js';
import { isTerminalFlowError } from '../common/flow-errors.js';
import { sectionCb } from '../section-module.js';
import { dayPickerKeyboard, zoneOf } from './day-picker.js';
import {
  fmtDay,
  isIsoDay,
  MINUTES_PER_DAY,
  minutesLabel,
  parseDayInput,
  parseTimeInput,
  toInstant,
} from './time-input.js';

export interface AddBlockData extends Record<string, unknown> {
  dateIso: string;
  startMin: number;
  endMin: number;
  title: string | null;
}

const DURATION_BUTTONS = [30, 60, 120, 240] as const;

/** 5.5.2 personal block: day → start → end (time or duration) → optional title → create. */
@Injectable()
export class AddBlockFlow extends Flow<AddBlockData> {
  readonly name = 'add-block';
  readonly firstStep = 'day';

  constructor(
    private readonly blocks: PersonalBlockUseCase,
    private readonly clock: Clock,
  ) {
    super();
  }

  async initial(): Promise<AddBlockData> {
    return { dateIso: '', startMin: 0, endMin: 0, title: null };
  }

  private async cancel(ctx: BotContext): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(ctx, ctx.t('cancel-done'), this.back(ctx));
    return { stay: true };
  }

  private back(ctx: BotContext): InlineKeyboard {
    return new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('today', 'day'));
  }

  readonly steps: Record<string, FlowStep<AddBlockData>> = {
    day: {
      enter: async (ctx) => {
        const kb = dayPickerKeyboard(ctx, zoneOf(ctx), this.clock.now(), (iso) => flowCb('day', 'pick', iso));
        kb.text(ctx.t('btn-cancel'), flowCb('day', 'cancel'));
        await renderMenu(ctx, ctx.t('block-new-day'), kb);
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.cancel(ctx);
        if (action === 'pick' && isIsoDay(args[0])) {
          d.dateIso = args[0];
          return { goto: 'start' };
        }
        return { stay: true };
      },
      onText: async (ctx, d, text) => {
        const iso = parseDayInput(text, zoneOf(ctx), this.clock.now());
        if (!iso) {
          await say(ctx, ctx.t('day-invalid'));
          return { stay: true };
        }
        d.dateIso = iso;
        return { goto: 'start' };
      },
    },
    start: {
      enter: async (ctx, d) =>
        renderMenu(
          ctx,
          ctx.t('block-new-start', { day: fmtDay(d.dateIso, zoneOf(ctx)) }),
          new InlineKeyboard().text(ctx.t('btn-cancel'), flowCb('start', 'cancel')),
        ),
      onCallback: async (ctx, _d, action) => (action === 'cancel' ? this.cancel(ctx) : { stay: true }),
      onText: async (ctx, d, text) => {
        const minutes = parseTimeInput(text);
        if (minutes === null) {
          await say(ctx, ctx.t('time-invalid'));
          return { stay: true };
        }
        d.startMin = minutes;
        return { goto: 'end' };
      },
    },
    end: {
      enter: async (ctx, d) => {
        const kb = new InlineKeyboard();
        for (const min of DURATION_BUTTONS)
          kb.text(ctx.t('btn-minutes', { n: min }), flowCb('end', 'dur', min));
        kb.row().text(ctx.t('btn-cancel'), flowCb('end', 'cancel'));
        await renderMenu(ctx, ctx.t('block-new-end', { start: minutesLabel(d.startMin) }), kb);
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.cancel(ctx);
        const n = Number(args[0]);
        if (action !== 'dur' || !Number.isInteger(n) || n <= 0) return { stay: true };
        d.endMin = Math.min(d.startMin + n, MINUTES_PER_DAY); // a block never crosses midnight: cap at 24:00
        return { goto: 'title' };
      },
      onText: async (ctx, d, text) => {
        const minutes = parseTimeInput(text);
        if (minutes === null) {
          await say(ctx, ctx.t('time-invalid'));
          return { stay: true };
        }
        if (minutes <= d.startMin) {
          await say(ctx, ctx.t('time-end-before-start'));
          return { stay: true };
        }
        d.endMin = minutes;
        return { goto: 'title' };
      },
    },
    title: {
      enter: async (ctx) =>
        renderMenu(
          ctx,
          ctx.t('block-new-title'),
          new InlineKeyboard().text(ctx.t('btn-skip'), flowCb('title', 'skip')),
        ),
      onCallback: async (_ctx, _d, action) => (action === 'skip' ? { done: true } : { stay: true }),
      onText: async (ctx, d, text) => {
        const title = text.trim();
        if (title.length > MAX_BLOCK_TITLE_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_BLOCK_TITLE_LENGTH }));
          return { stay: true };
        }
        d.title = title || null;
        return { done: true };
      },
    },
  };

  async complete(ctx: BotContext, d: AddBlockData): Promise<void | { goto: string }> {
    if (!ctx.actor) {
      ctx.session.flow = undefined;
      return;
    }
    const zone = zoneOf(ctx);
    const start = toInstant(d.dateIso, d.startMin, zone);
    const end = toInstant(d.dateIso, d.endMin, zone);
    if (!start || !end) {
      await say(ctx, ctx.t('time-nonexistent')); // spring-forward gap (CAL-05)
      return { goto: 'start' };
    }
    try {
      await this.blocks.create(ctx.actor.actor, { during: { start, end }, title: d.title });
    } catch (error) {
      if (AppError.is(error, 'LESSON_CONFLICT')) {
        await say(ctx, ctx.t('block-conflict'));
        return { goto: 'start' };
      }
      if (AppError.is(error, 'VALIDATION_ERROR') && error.details?.['reason'] === 'past') {
        await say(ctx, ctx.t('block-in-past'));
        return { goto: 'day' };
      }
      if (isTerminalFlowError(error)) ctx.session.flow = undefined;
      throw error;
    }
    await renderMenu(
      ctx,
      ctx.t('block-created', {
        day: fmtDay(d.dateIso, zone),
        from: minutesLabel(d.startMin),
        to: minutesLabel(d.endMin),
        title: d.title ? escapeHtml(d.title) : '',
      }),
      this.back(ctx),
    );
  }
}
