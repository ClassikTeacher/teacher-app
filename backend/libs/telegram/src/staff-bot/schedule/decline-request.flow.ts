import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import { CancelTemplatesQuery } from '@modules/schedule/cancellations/cancel-templates.query.js';
import { MAX_RESCHEDULE_COMMENT_LENGTH } from '@modules/schedule/reschedule/reschedule-lesson.use-case.js';
import { RescheduleRequestUseCase } from '@modules/schedule/reschedule/reschedule-request.use-case.js';
import type { BotContext } from '../../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../../core/flow.js';
import { clip } from '../../core/format.js';
import { renderMenu, say } from '../../core/ui.js';
import { resolveRef, shortRef } from '../common/short-ref.js';
import { sectionCb } from '../section-module.js';

export interface DeclineRequestData extends Record<string, unknown> {
  requestId: string;
  message: string;
}

/** 5.5.5 3б: «Отклонить» needs a message — a reason template, the default notice text, or own text. */
@Injectable()
export class DeclineRequestFlow extends Flow<DeclineRequestData> {
  readonly name = 'decline-request';
  readonly firstStep = 'message';

  constructor(
    private readonly requests: RescheduleRequestUseCase,
    private readonly templates: CancelTemplatesQuery,
  ) {
    super();
  }

  async initial(_ctx: BotContext, arg: unknown): Promise<DeclineRequestData> {
    const { requestId } = arg as { requestId: string };
    return { requestId, message: '' };
  }

  private back(ctx: BotContext): InlineKeyboard {
    return new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('today', 'requests'));
  }

  private async leave(ctx: BotContext, text: string): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(ctx, text, this.back(ctx));
    return { stay: true };
  }

  readonly steps: Record<string, FlowStep<DeclineRequestData>> = {
    message: {
      enter: async (ctx) => {
        const options = await this.templates.forActor(ctx.actor!.actor, 'TEACHER');
        const kb = new InlineKeyboard();
        options.forEach((t, i) =>
          kb.text(clip(t.text, 40), flowCb('message', 'pick', ...shortRef(t.text, i))).row(),
        );
        kb.text(ctx.t('btn-cancel'), flowCb('message', 'cancel'));
        await renderMenu(ctx, ctx.t('request-decline-prompt'), kb);
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.leave(ctx, ctx.t('cancel-done'));
        if (action !== 'pick') return { stay: true };
        const options = await this.templates.forActor(ctx.actor!.actor, 'TEACHER');
        const picked = resolveRef(options, args[0], args[1], (t) => t.text);
        if (!picked) return { stay: true };
        d.message = picked.text;
        return { done: true };
      },
      onText: async (ctx, d, text) => {
        const clean = text.trim();
        if (!clean || clean.length > MAX_RESCHEDULE_COMMENT_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_RESCHEDULE_COMMENT_LENGTH }));
          return { stay: true };
        }
        d.message = clean;
        return { done: true };
      },
    },
  };

  async complete(ctx: BotContext, d: DeclineRequestData): Promise<void> {
    try {
      await this.requests.decide(ctx.actor!.actor, {
        requestId: d.requestId,
        accept: false,
        message: d.message,
      });
    } catch (error) {
      if (AppError.is(error, 'CONFLICT') || AppError.is(error, 'NOT_FOUND')) {
        ctx.session.flow = undefined;
        await renderMenu(ctx, ctx.t('request-gone'), this.back(ctx));
        return;
      }
      throw error;
    }
    await renderMenu(ctx, ctx.t('request-declined'), this.back(ctx));
  }
}
