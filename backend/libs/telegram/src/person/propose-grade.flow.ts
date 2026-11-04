import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { DateTime } from 'luxon';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { GradeEntriesUseCase } from '@modules/gradebook/grade-entries.use-case.js';
import { MAX_ENTRY_COMMENT_LENGTH } from '@modules/gradebook/gradebook.rules.js';
import { SCHOOL_CATEGORIES, type SchoolCategory } from '@modules/gradebook/schema.js';
import type { BotContext } from '../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../core/flow.js';
import { renderMenu, say } from '../core/ui.js';
import { parseDayInput } from '../staff-bot/schedule/time-input.js';

export interface ProposeGradePreset {
  journalId: string;
  /** A parent reports for this child. */
  studentId?: string;
  /** Callback of «Назад» after the dialog (the journal screen). */
  back: string;
}

export interface ProposeGradeData extends Record<string, unknown>, ProposeGradePreset {
  value: number | null;
  category: SchoolCategory | null;
  date: string | null;
  comment: string | null;
}

/** UC-30 (5.11.2 💡): «Получил 8 за контрольную» — value → category → day → comment → waits for the teacher. */
@Injectable()
export class ProposeGradeFlow extends Flow<ProposeGradeData> {
  readonly name = 'propose-grade';
  readonly firstStep = 'value';

  constructor(
    private readonly entries: GradeEntriesUseCase,
    private readonly clock: Clock,
  ) {
    super();
  }

  async initial(_ctx: BotContext, arg: unknown): Promise<ProposeGradeData> {
    return { ...(arg as ProposeGradePreset), value: null, category: null, date: null, comment: null };
  }

  private zone(ctx: BotContext): string {
    return ctx.actor?.account.timezone ?? 'UTC';
  }

  private async cancel(ctx: BotContext, d: ProposeGradeData): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(ctx, ctx.t('cancel-done'), new InlineKeyboard().text(ctx.t('btn-back'), d.back));
    return { stay: true };
  }

  readonly steps: Record<string, FlowStep<ProposeGradeData>> = {
    value: {
      enter: async (ctx) => {
        const kb = new InlineKeyboard();
        for (let v = 1; v <= 10; v += 1) {
          kb.text(String(v), flowCb('value', 'n', v));
          if (v % 5 === 0) kb.row();
        }
        kb.text(ctx.t('btn-cancel'), flowCb('value', 'cancel'));
        await renderMenu(ctx, ctx.t('propose-ask-value'), kb);
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.cancel(ctx, d);
        if (action !== 'n') return { stay: true };
        d.value = Number(args[0]);
        return { goto: 'category' };
      },
      onText: async (ctx, d, text) => {
        const value = Number(text.trim());
        if (!Number.isInteger(value) || value < 1 || value > 10) {
          await say(ctx, ctx.t('grade-value-invalid'));
          return { stay: true };
        }
        d.value = value;
        return { goto: 'category' };
      },
    },
    category: {
      enter: async (ctx) => {
        const kb = new InlineKeyboard();
        SCHOOL_CATEGORIES.forEach((c, i) => {
          kb.text(ctx.t('grade-category', { key: c }), flowCb('category', 'c', i));
          if (i % 2 === 1) kb.row();
        });
        kb.row().text(ctx.t('btn-cancel'), flowCb('category', 'cancel'));
        await renderMenu(ctx, ctx.t('grade-ask-category'), kb);
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.cancel(ctx, d);
        const c = SCHOOL_CATEGORIES[Number(args[0])];
        if (action !== 'c' || !c) return { stay: true };
        d.category = c;
        return { goto: 'date' };
      },
    },
    date: {
      enter: async (ctx) => {
        const today = DateTime.fromJSDate(this.clock.now(), { zone: this.zone(ctx) });
        await renderMenu(
          ctx,
          ctx.t('grade-ask-date'),
          new InlineKeyboard()
            .text(ctx.t('btn-day-today'), flowCb('date', 'd', today.toISODate()!))
            .text(ctx.t('btn-day-yesterday'), flowCb('date', 'd', today.minus({ days: 1 }).toISODate()!))
            .row()
            .text(ctx.t('btn-cancel'), flowCb('date', 'cancel')),
        );
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.cancel(ctx, d);
        if (action !== 'd' || !args[0]) return { stay: true };
        d.date = args[0];
        return { goto: 'comment' };
      },
      onText: async (ctx, d, text) => {
        const today = DateTime.fromJSDate(this.clock.now(), { zone: this.zone(ctx) }).toISODate()!;
        let iso = parseDayInput(text, this.zone(ctx), this.clock.now());
        if (iso && iso > today && !/\d{2,4}$/.test(text.trim().split(/[.\-/]/)[2] ?? ''))
          iso = DateTime.fromISO(iso).minus({ years: 1 }).toISODate();
        if (!iso || iso > today) {
          await say(ctx, ctx.t('grade-date-invalid'));
          return { stay: true };
        }
        d.date = iso;
        return { goto: 'comment' };
      },
    },
    comment: {
      enter: async (ctx) =>
        renderMenu(
          ctx,
          ctx.t('propose-ask-comment'),
          new InlineKeyboard()
            .text(ctx.t('btn-skip'), flowCb('comment', 'skip'))
            .text(ctx.t('btn-cancel'), flowCb('comment', 'cancel')),
        ),
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.cancel(ctx, d);
        return action === 'skip' ? { done: true } : { stay: true };
      },
      onText: async (ctx, d, text) => {
        if (text.length > MAX_ENTRY_COMMENT_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_ENTRY_COMMENT_LENGTH }));
          return { stay: true };
        }
        d.comment = text.trim() || null;
        return { done: true };
      },
    },
  };

  async complete(ctx: BotContext, d: ProposeGradeData): Promise<void> {
    if (!ctx.actor || d.value === null) return;
    const back = new InlineKeyboard().text(ctx.t('btn-back'), d.back);
    try {
      const row = await this.entries.propose(ctx.actor.actor, {
        journalId: d.journalId,
        value: d.value,
        category: d.category,
        date: d.date,
        comment: d.comment,
        studentId: d.studentId,
      });
      await renderMenu(ctx, ctx.t(row.status === 'confirmed' ? 'propose-recorded' : 'propose-sent'), back);
    } catch (error) {
      ctx.session.flow = undefined;
      if (AppError.is(error, 'LIMIT_EXCEEDED')) return renderMenu(ctx, ctx.t('propose-too-many'), back);
      if (
        AppError.is(error, 'NOT_FOUND') ||
        AppError.is(error, 'LINK_NOT_ACTIVE') ||
        AppError.is(error, 'FEATURE_DISABLED')
      )
        return renderMenu(ctx, ctx.t('callback-stale'), back);
      throw error;
    }
  }
}
