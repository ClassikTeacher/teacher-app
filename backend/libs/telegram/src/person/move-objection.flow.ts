import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import {
  MAX_RESCHEDULE_COMMENT_LENGTH,
  RescheduleLessonUseCase,
} from '@modules/schedule/reschedule/reschedule-lesson.use-case.js';
import type { BotContext } from '../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../core/flow.js';
import { renderMenu, say } from '../core/ui.js';

export interface MoveObjectionData extends Record<string, unknown> {
  lessonId: string;
  /** The child for a parent (Р-25), the student's own id otherwise. */
  studentId: string;
  backCb: string;
  reason?: string;
}

/** «Не могу в это время» on a move notice (5.7.4): one mandatory reason, then the teacher is told. */
@Injectable()
export class MoveObjectionFlow extends Flow<MoveObjectionData> {
  readonly name = 'move-objection';
  readonly firstStep = 'reason';

  constructor(private readonly reschedule: RescheduleLessonUseCase) {
    super();
  }

  async initial(_ctx: BotContext, arg: unknown): Promise<MoveObjectionData> {
    return arg as MoveObjectionData;
  }

  private async leave(ctx: BotContext, d: MoveObjectionData, text: string): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(ctx, text, new InlineKeyboard().text(ctx.t('btn-cancel-back'), d.backCb));
    return { stay: true };
  }

  readonly steps: Record<string, FlowStep<MoveObjectionData>> = {
    reason: {
      enter: async (ctx) => {
        await renderMenu(
          ctx,
          ctx.t('move-objection-prompt'),
          new InlineKeyboard().text(ctx.t('btn-cancel'), flowCb('reason', 'cancel')),
        );
      },
      onCallback: async (ctx, d, action) =>
        action === 'cancel' ? this.leave(ctx, d, ctx.t('cancel-done')) : { stay: true },
      onText: async (ctx, d, text) => {
        const clean = text.trim();
        if (!clean || clean.length > MAX_RESCHEDULE_COMMENT_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_RESCHEDULE_COMMENT_LENGTH }));
          return { stay: true };
        }
        d.reason = clean;
        return { done: true };
      },
    },
  };

  async complete(ctx: BotContext, d: MoveObjectionData): Promise<void> {
    try {
      await this.reschedule.object(ctx.actor!.actor, {
        lessonId: d.lessonId,
        reason: d.reason ?? '',
        studentId: ctx.bot === 'parent' ? d.studentId : undefined,
      });
    } catch (error) {
      if (AppError.is(error, 'NOT_FOUND') || AppError.is(error, 'CONFLICT')) {
        ctx.session.flow = undefined;
        await renderMenu(
          ctx,
          ctx.t('cancel-not-possible', { code: 'conflict', hours: 0 }),
          new InlineKeyboard().text(ctx.t('btn-cancel-back'), d.backCb),
        );
        return;
      }
      throw error;
    }
    await renderMenu(
      ctx,
      ctx.t('move-objection-done'),
      new InlineKeyboard().text(ctx.t('btn-cancel-back'), d.backCb),
    );
  }
}
