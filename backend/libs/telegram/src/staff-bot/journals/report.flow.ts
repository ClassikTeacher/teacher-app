import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { DateTime } from 'luxon';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { renderReport } from '@modules/gradebook/report-text.js';
import { MAX_REPORT_COMMENT_LENGTH, ReportsUseCase } from '@modules/gradebook/reports.use-case.js';
import type { BotContext } from '../../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../../core/flow.js';
import { renderMenu, say } from '../../core/ui.js';
import { isTerminalFlowError } from '../common/flow-errors.js';
import { sectionCb } from '../section-module.js';

export interface ReportFlowPreset {
  linkId: string;
}

export interface ReportFlowData extends Record<string, unknown>, ReportFlowPreset {
  from: string | null;
  to: string | null;
  comment: string | null;
  /** `send` after the preview, `draft` to keep it unsent. */
  decision: 'send' | 'draft' | null;
}

const PERIOD =
  /^(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{4}))?\s*[—–-]\s*(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{4}))?$/;

/** UC-31: period (this month / previous month / typed) → teacher's comment → preview → send or keep a draft. */
@Injectable()
export class ReportFlow extends Flow<ReportFlowData> {
  readonly name = 'report';
  readonly firstStep = 'period';

  constructor(
    private readonly reports: ReportsUseCase,
    private readonly clock: Clock,
  ) {
    super();
  }

  async initial(_ctx: BotContext, arg: unknown): Promise<ReportFlowData> {
    return { ...(arg as ReportFlowPreset), from: null, to: null, comment: null, decision: null };
  }

  private back(ctx: BotContext, d: ReportFlowData): InlineKeyboard {
    return new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('reports', 'list', d.linkId));
  }

  private async cancel(ctx: BotContext, d: ReportFlowData): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(ctx, ctx.t('cancel-done'), this.back(ctx, d));
    return { stay: true };
  }

  private zone(ctx: BotContext): string {
    return ctx.actor?.account.timezone ?? 'UTC';
  }

  readonly steps: Record<string, FlowStep<ReportFlowData>> = {
    period: {
      enter: async (ctx) =>
        renderMenu(
          ctx,
          ctx.t('report-ask-period'),
          new InlineKeyboard()
            .text(ctx.t('btn-period-month'), flowCb('period', 'm'))
            .text(ctx.t('btn-period-prev'), flowCb('period', 'p'))
            .row()
            .text(ctx.t('btn-cancel'), flowCb('period', 'cancel')),
        ),
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.cancel(ctx, d);
        const now = DateTime.fromJSDate(this.clock.now(), { zone: this.zone(ctx) });
        const month = action === 'p' ? now.minus({ months: 1 }) : now;
        if (action !== 'm' && action !== 'p') return { stay: true };
        d.from = month.startOf('month').toISODate();
        d.to = (action === 'm' ? now : month.endOf('month')).toISODate();
        return { goto: 'comment' };
      },
      onText: async (ctx, d, text) => {
        const m = PERIOD.exec(text.trim());
        const year = DateTime.fromJSDate(this.clock.now(), { zone: this.zone(ctx) }).year;
        const from =
          m &&
          DateTime.fromObject({ year: m[3] ? Number(m[3]) : year, month: Number(m[2]), day: Number(m[1]) });
        const to =
          m &&
          DateTime.fromObject({ year: m[6] ? Number(m[6]) : year, month: Number(m[5]), day: Number(m[4]) });
        if (!from || !to || !from.isValid || !to.isValid || from > to) {
          await say(ctx, ctx.t('report-period-invalid'));
          return { stay: true };
        }
        d.from = from.toISODate();
        d.to = to.toISODate();
        return { goto: 'comment' };
      },
    },
    comment: {
      enter: async (ctx) =>
        renderMenu(
          ctx,
          ctx.t('report-ask-comment'),
          new InlineKeyboard()
            .text(ctx.t('btn-skip'), flowCb('comment', 'skip'))
            .text(ctx.t('btn-cancel'), flowCb('comment', 'cancel')),
        ),
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.cancel(ctx, d);
        return action === 'skip' ? { goto: 'preview' } : { stay: true };
      },
      onText: async (ctx, d, text) => {
        if (text.length > MAX_REPORT_COMMENT_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_REPORT_COMMENT_LENGTH }));
          return { stay: true };
        }
        d.comment = text.trim() || null;
        return { goto: 'preview' };
      },
    },
    preview: {
      enter: async (ctx, d) => {
        if (!ctx.actor || !d.from || !d.to) return;
        let body: string;
        try {
          const snapshot = await this.reports.preview(ctx.actor.actor, {
            linkId: d.linkId,
            from: d.from,
            to: d.to,
          });
          body = renderReport((k, v) => ctx.t(k, v), snapshot, d.comment);
        } catch (error) {
          if (!AppError.is(error, 'VALIDATION_ERROR')) throw error;
          await say(ctx, ctx.t('report-period-invalid'));
          ctx.session.flow!.step = 'period';
          return this.steps['period']!.enter(ctx, d);
        }
        await renderMenu(
          ctx,
          ctx.t('report-preview', { body }),
          new InlineKeyboard()
            .text(ctx.t('btn-report-send'), flowCb('preview', 'send'))
            .text(ctx.t('btn-report-draft'), flowCb('preview', 'draft'))
            .row()
            .text(ctx.t('btn-cancel'), flowCb('preview', 'cancel')),
        );
      },
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.cancel(ctx, d);
        if (action !== 'send' && action !== 'draft') return { stay: true };
        d.decision = action;
        return { done: true };
      },
    },
  };

  async complete(ctx: BotContext, d: ReportFlowData): Promise<void> {
    if (!ctx.actor || !d.from || !d.to) return;
    try {
      const row = await this.reports.create(ctx.actor.actor, {
        linkId: d.linkId,
        from: d.from,
        to: d.to,
        comment: d.comment,
      });
      if (d.decision === 'send') await this.reports.send(ctx.actor.actor, row.id);
      await renderMenu(
        ctx,
        ctx.t(d.decision === 'send' ? 'report-sent-done' : 'report-draft-saved'),
        this.back(ctx, d),
      );
    } catch (error) {
      if (isTerminalFlowError(error)) ctx.session.flow = undefined;
      throw error;
    }
  }
}
