import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { AvailabilityUseCase } from '@modules/schedule/availability/availability.use-case.js';
import type { ExceptionKind } from '@modules/schedule/schema.js';
import type { BotContext } from '../../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../../core/flow.js';
import { renderMenu, say } from '../../core/ui.js';
import { isTerminalFlowError } from '../common/flow-errors.js';
import { dayPickerKeyboard, zoneOf } from '../schedule/day-picker.js';
import { fmtDay, isIsoDay, minutesLabel, parseDayInput, parseTimeInput } from '../schedule/time-input.js';
import { sectionCb } from '../section-module.js';

export interface AddExceptionData extends Record<string, unknown> {
  kind: ExceptionKind;
  dateIso: string;
  startMin: number | null;
  endMin: number | null;
}

/** 5.5.4 exceptions: date → whole day (closed only) or from → to → save. */
@Injectable()
export class AddExceptionFlow extends Flow<AddExceptionData> {
  readonly name = 'add-exception';
  readonly firstStep = 'day';

  constructor(
    private readonly availability: AvailabilityUseCase,
    private readonly clock: Clock,
  ) {
    super();
  }

  async initial(_ctx: BotContext, arg: unknown): Promise<AddExceptionData> {
    const kind = (arg as { kind?: ExceptionKind } | undefined)?.kind === 'extra' ? 'extra' : 'closed';
    return { kind, dateIso: '', startMin: null, endMin: null };
  }

  private async cancel(ctx: BotContext): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(ctx, ctx.t('cancel-done'), this.back(ctx));
    return { stay: true };
  }

  private back(ctx: BotContext): InlineKeyboard {
    return new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('settings', 'windows'));
  }

  readonly steps: Record<string, FlowStep<AddExceptionData>> = {
    day: {
      enter: async (ctx, d) => {
        const kb = dayPickerKeyboard(ctx, zoneOf(ctx), this.clock.now(), (iso) => flowCb('day', 'pick', iso));
        kb.text(ctx.t('btn-cancel'), flowCb('day', 'cancel'));
        await renderMenu(ctx, ctx.t(`exception-new-day-${d.kind}`), kb);
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
      enter: async (ctx, d) => {
        const kb = new InlineKeyboard();
        if (d.kind === 'closed') kb.text(ctx.t('btn-whole-day'), flowCb('start', 'whole'));
        kb.text(ctx.t('btn-cancel'), flowCb('start', 'cancel'));
        await renderMenu(
          ctx,
          ctx.t(`exception-new-start-${d.kind}`, { day: fmtDay(d.dateIso, zoneOf(ctx)) }),
          kb,
        );
      },
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.cancel(ctx);
        if (action === 'whole' && d.kind === 'closed') return { done: true };
        return { stay: true };
      },
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
          ctx.t('rule-new-end', { start: minutesLabel(d.startMin ?? 0) }),
          new InlineKeyboard().text(ctx.t('btn-cancel'), flowCb('end', 'cancel')),
        ),
      onCallback: async (ctx, _d, action) => (action === 'cancel' ? this.cancel(ctx) : { stay: true }),
      onText: async (ctx, d, text) => {
        const minutes = text.trim() === '24:00' ? 24 * 60 : parseTimeInput(text);
        if (minutes === null) {
          await say(ctx, ctx.t('time-invalid'));
          return { stay: true };
        }
        if (minutes <= (d.startMin ?? 0)) {
          await say(ctx, ctx.t('time-end-before-start'));
          return { stay: true };
        }
        d.endMin = minutes;
        return { done: true };
      },
    },
  };

  async complete(ctx: BotContext, d: AddExceptionData): Promise<void | { goto: string }> {
    if (!ctx.actor) {
      ctx.session.flow = undefined;
      return;
    }
    try {
      await this.availability.addException(ctx.actor.actor, {
        date: d.dateIso,
        kind: d.kind,
        startMin: d.startMin,
        endMin: d.endMin,
      });
    } catch (error) {
      if (AppError.is(error, 'VALIDATION_ERROR') && error.details?.['reason'] === 'past') {
        await say(ctx, ctx.t('exception-in-past'));
        return { goto: 'day' };
      }
      if (isTerminalFlowError(error)) ctx.session.flow = undefined;
      throw error;
    }
    await renderMenu(
      ctx,
      ctx.t(`exception-created-${d.kind}`, { day: fmtDay(d.dateIso, zoneOf(ctx)) }),
      this.back(ctx),
    );
  }
}
