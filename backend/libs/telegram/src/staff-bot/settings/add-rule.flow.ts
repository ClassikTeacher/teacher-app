import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AvailabilityUseCase } from '@modules/schedule/availability/availability.use-case.js';
import type { BotContext } from '../../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../../core/flow.js';
import { renderMenu, say } from '../../core/ui.js';
import { isTerminalFlowError } from '../common/flow-errors.js';
import { minutesLabel, parseTimeInput } from '../schedule/time-input.js';
import { sectionCb } from '../section-module.js';
import { WEEKDAY_KEYS } from './windows.screen.js';

export interface AddRuleData extends Record<string, unknown> {
  weekdays: number[];
  startMin: number;
  endMin: number;
}

/** 5.5.4 weekly rule: weekdays (multi-select) → from → to → save. */
@Injectable()
export class AddRuleFlow extends Flow<AddRuleData> {
  readonly name = 'add-rule';
  readonly firstStep = 'days';

  constructor(private readonly availability: AvailabilityUseCase) {
    super();
  }

  async initial(): Promise<AddRuleData> {
    return { weekdays: [], startMin: 0, endMin: 0 };
  }

  private async cancel(ctx: BotContext): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(ctx, ctx.t('cancel-done'), this.back(ctx));
    return { stay: true };
  }

  private back(ctx: BotContext): InlineKeyboard {
    return new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('settings', 'windows'));
  }

  readonly steps: Record<string, FlowStep<AddRuleData>> = {
    days: {
      enter: async (ctx, d) => {
        const kb = new InlineKeyboard();
        WEEKDAY_KEYS.forEach((key, i) => {
          const mark = d.weekdays.includes(i + 1) ? '✅ ' : '';
          kb.text(`${mark}${ctx.t(`weekday-${key}`)}`, flowCb('days', 'toggle', i + 1));
          if (i === 4) kb.row();
        });
        kb.row()
          .text(ctx.t('btn-weekdays-workdays'), flowCb('days', 'workdays'))
          .text(ctx.t('btn-next'), flowCb('days', 'next'))
          .row()
          .text(ctx.t('btn-cancel'), flowCb('days', 'cancel'));
        await renderMenu(ctx, ctx.t('rule-new-days', { count: d.weekdays.length }), kb);
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.cancel(ctx);
        if (action === 'workdays') {
          d.weekdays = [1, 2, 3, 4, 5];
          return { goto: 'days' };
        }
        if (action === 'toggle') {
          const day = Number(args[0]);
          if (!Number.isInteger(day) || day < 1 || day > 7) return { stay: true };
          d.weekdays = d.weekdays.includes(day)
            ? d.weekdays.filter((x) => x !== day)
            : [...d.weekdays, day].sort((a, b) => a - b);
          return { goto: 'days' };
        }
        if (action === 'next') {
          if (d.weekdays.length === 0) {
            await ctx.answerCallbackQuery({ text: ctx.t('rule-days-required') }).catch(() => undefined);
            return { stay: true };
          }
          return { goto: 'start' };
        }
        return { stay: true };
      },
    },
    start: {
      enter: async (ctx) =>
        renderMenu(
          ctx,
          ctx.t('rule-new-start'),
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
      enter: async (ctx, d) =>
        renderMenu(
          ctx,
          ctx.t('rule-new-end', { start: minutesLabel(d.startMin) }),
          new InlineKeyboard().text(ctx.t('btn-cancel'), flowCb('end', 'cancel')),
        ),
      onCallback: async (ctx, _d, action) => (action === 'cancel' ? this.cancel(ctx) : { stay: true }),
      onText: async (ctx, d, text) => {
        const minutes = text.trim() === '24:00' ? 24 * 60 : parseTimeInput(text);
        if (minutes === null) {
          await say(ctx, ctx.t('time-invalid'));
          return { stay: true };
        }
        if (minutes <= d.startMin) {
          await say(ctx, ctx.t('time-end-before-start'));
          return { stay: true };
        }
        d.endMin = minutes;
        return { done: true };
      },
    },
  };

  async complete(ctx: BotContext, d: AddRuleData): Promise<void> {
    if (!ctx.actor) {
      ctx.session.flow = undefined;
      return;
    }
    try {
      await this.availability.addRule(ctx.actor.actor, {
        weekdays: d.weekdays,
        startMin: d.startMin,
        endMin: d.endMin,
      });
    } catch (error) {
      if (isTerminalFlowError(error)) ctx.session.flow = undefined;
      throw error;
    }
    await renderMenu(ctx, ctx.t('rule-created'), this.back(ctx));
  }
}
