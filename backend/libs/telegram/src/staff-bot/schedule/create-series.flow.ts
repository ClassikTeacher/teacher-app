import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { DateTime } from 'luxon';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import type { LessonTarget } from '@modules/schedule/lessons/create-lesson.use-case.js';
import { SeriesUseCase } from '@modules/schedule/series/series.use-case.js';
import type { BotContext } from '../../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../../core/flow.js';
import { escapeHtml, renderMenu, say } from '../../core/ui.js';
import { isTerminalFlowError } from '../common/flow-errors.js';
import { sectionCb } from '../section-module.js';
import { WEEKDAY_KEYS } from '../settings/windows.screen.js';
import { zoneOf } from './day-picker.js';
import { fmtDay, fmtTime, minutesLabel, parseDayInput } from './time-input.js';

/** Preset from a lesson card ("Сделать регулярным", 5.6.3): the lesson's participants, time and weekday. */
export interface CreateSeriesPreset {
  target: LessonTarget;
  label: string;
  startMin: number;
  durationMin: number;
  weekday: number;
  startsOn: string;
  subjectId: string | null;
}

export interface CreateSeriesData extends Record<string, unknown>, CreateSeriesPreset {
  weekdays: number[];
  endsOn: string | null;
}

/** UC-15: weekdays (preset: the lesson's) → end date or "без конца" → create and report conflicts. */
@Injectable()
export class CreateSeriesFlow extends Flow<CreateSeriesData> {
  readonly name = 'create-series';
  readonly firstStep = 'days';

  constructor(
    private readonly series: SeriesUseCase,
    private readonly clock: Clock,
  ) {
    super();
  }

  async initial(_ctx: BotContext, arg: unknown): Promise<CreateSeriesData> {
    const preset = arg as CreateSeriesPreset;
    return { ...preset, weekdays: [preset.weekday], endsOn: null };
  }

  private async cancel(ctx: BotContext): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(ctx, ctx.t('cancel-done'), this.back(ctx));
    return { stay: true };
  }

  private back(ctx: BotContext): InlineKeyboard {
    return new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('today', 'series'));
  }

  readonly steps: Record<string, FlowStep<CreateSeriesData>> = {
    days: {
      enter: async (ctx, d) => {
        const kb = new InlineKeyboard();
        WEEKDAY_KEYS.forEach((key, i) => {
          const mark = d.weekdays.includes(i + 1) ? '✅ ' : '';
          kb.text(`${mark}${ctx.t(`weekday-${key}`)}`, flowCb('days', 'toggle', i + 1));
          if (i === 4) kb.row();
        });
        kb.row()
          .text(ctx.t('btn-next'), flowCb('days', 'next'))
          .text(ctx.t('btn-cancel'), flowCb('days', 'cancel'));
        await renderMenu(
          ctx,
          ctx.t('series-new-days', {
            who: escapeHtml(d.label),
            time: minutesLabel(d.startMin),
            duration: d.durationMin,
          }),
          kb,
        );
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.cancel(ctx);
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
          return { goto: 'end' };
        }
        return { stay: true };
      },
    },
    end: {
      enter: async (ctx, d) =>
        renderMenu(
          ctx,
          ctx.t('series-new-end', { start: fmtDay(d.startsOn, zoneOf(ctx)) }),
          new InlineKeyboard()
            .text(ctx.t('btn-no-end'), flowCb('end', 'none'))
            .text(ctx.t('btn-cancel'), flowCb('end', 'cancel')),
        ),
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.cancel(ctx);
        if (action === 'none') {
          d.endsOn = null;
          return { done: true };
        }
        return { stay: true };
      },
      onText: async (ctx, d, text) => {
        const iso = parseDayInput(text, zoneOf(ctx), this.clock.now());
        if (!iso || iso < d.startsOn) {
          await say(ctx, ctx.t('day-invalid'));
          return { stay: true };
        }
        d.endsOn = iso;
        return { done: true };
      },
    },
  };

  async complete(ctx: BotContext, d: CreateSeriesData): Promise<void> {
    if (!ctx.actor) {
      ctx.session.flow = undefined;
      return;
    }
    const zone = zoneOf(ctx);
    try {
      const { series, report } = await this.series.create(ctx.actor.actor, {
        target: d.target,
        weekdays: d.weekdays,
        startMin: d.startMin,
        durationMin: d.durationMin,
        startsOn: d.startsOn,
        endsOn: d.endsOn,
        subjectId: d.subjectId,
      });
      const conflicts = report.conflicts
        .map(
          (c) =>
            `${fmtDay(DateTime.fromJSDate(c.during.start, { zone }).toISODate()!, zone)} ${fmtTime(c.during.start, zone)}`,
        )
        .join(', ');
      await renderMenu(
        ctx,
        ctx.t(report.conflicts.length > 0 ? 'series-created-conflicts' : 'series-created', {
          who: escapeHtml(d.label),
          created: report.created,
          conflicts: escapeHtml(conflicts),
        }),
        new InlineKeyboard()
          .text(ctx.t('btn-series-card'), sectionCb('today', 'scard', series.id))
          .text(ctx.t('btn-back'), sectionCb('today', 'day')),
      );
    } catch (error) {
      if (
        AppError.is(error, 'LINK_NOT_ACTIVE') ||
        AppError.is(error, 'NOT_FOUND') ||
        AppError.is(error, 'CONFLICT')
      ) {
        ctx.session.flow = undefined;
        await renderMenu(ctx, ctx.t('lesson-target-gone'), this.back(ctx));
        return;
      }
      if (isTerminalFlowError(error)) ctx.session.flow = undefined;
      throw error;
    }
  }
}
