import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import { MAX_REVIEW_COMMENT_LENGTH } from '@modules/homework/homework.rules.js';
import { ReviewUseCase } from '@modules/homework/review.use-case.js';
import type { ReviewDecision } from '@modules/homework/schema.js';
import { IngestFileUseCase } from '@modules/files/ingest-file.use-case.js';
import type { BotContext } from '../../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../../core/flow.js';
import { mediaOf, UPLOADABLE_KINDS } from '../../core/media.js';
import { renderMenu, say } from '../../core/ui.js';
import { isTerminalFlowError } from '../common/flow-errors.js';
import { sectionCb } from '../section-module.js';

export interface ReviewPreset {
  submissionId: string;
  decision: ReviewDecision;
}

export interface ReviewData extends Record<string, unknown>, ReviewPreset {
  comment: string | null;
  fileIds: string[];
}

/** UC-28: «Принять» (comment optional) or «На доработку» (comment required) → checked files (optional) → done. */
@Injectable()
export class ReviewFlow extends Flow<ReviewData> {
  readonly name = 'review';
  readonly firstStep = 'comment';

  constructor(
    private readonly review: ReviewUseCase,
    private readonly ingest: IngestFileUseCase,
  ) {
    super();
  }

  async initial(_ctx: BotContext, arg: unknown): Promise<ReviewData> {
    return { ...(arg as ReviewPreset), comment: null, fileIds: [] };
  }

  private back(ctx: BotContext, d: ReviewData): InlineKeyboard {
    return new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('assignments', 'sub', d.submissionId));
  }

  private async cancel(ctx: BotContext, d: ReviewData): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(ctx, ctx.t('cancel-done'), this.back(ctx, d));
    return { stay: true };
  }

  readonly steps: Record<string, FlowStep<ReviewData>> = {
    comment: {
      enter: async (ctx, d) => {
        const kb = new InlineKeyboard();
        if (d.decision === 'accepted') kb.text(ctx.t('btn-skip'), flowCb('comment', 'skip'));
        kb.text(ctx.t('btn-cancel'), flowCb('comment', 'cancel'));
        await renderMenu(
          ctx,
          ctx.t(d.decision === 'accepted' ? 'review-comment-optional' : 'review-comment-required'),
          kb,
        );
      },
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.cancel(ctx, d);
        return action === 'skip' && d.decision === 'accepted' ? { goto: 'files' } : { stay: true };
      },
      onText: async (ctx, d, text) => {
        if (!text || text.length > MAX_REVIEW_COMMENT_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_REVIEW_COMMENT_LENGTH }));
          return { stay: true };
        }
        d.comment = text;
        return { goto: 'files' };
      },
    },
    files: {
      enter: async (ctx, d) =>
        renderMenu(
          ctx,
          ctx.t('review-files', { count: d.fileIds.length }),
          new InlineKeyboard()
            .text(ctx.t(d.fileIds.length > 0 ? 'btn-done' : 'btn-skip'), flowCb('files', 'done'))
            .text(ctx.t('btn-cancel'), flowCb('files', 'cancel')),
        ),
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.cancel(ctx, d);
        return action === 'done' ? { done: true } : { stay: true };
      },
      onMedia: async (ctx, d, message) => {
        const media = mediaOf(message);
        if (!media || !UPLOADABLE_KINDS.includes(media.kind) || !ctx.actor) {
          await say(ctx, ctx.t('upload-kind-refused'));
          return { stay: true };
        }
        try {
          const row = await this.ingest.execute({
            actor: ctx.actor.actor,
            ownerTeacherId: ctx.actor.actor.accountId,
            bot: 'staff',
            api: ctx.api,
            telegram: media.file,
          });
          d.fileIds = [...d.fileIds, row.id];
          return { goto: 'files' };
        } catch (error) {
          if (AppError.is(error, 'FILE_TYPE_NOT_ALLOWED') || AppError.is(error, 'FILE_TOO_LARGE')) {
            await say(ctx, ctx.t(`error-${error.code.toLowerCase().replace(/_/g, '-')}`));
            return { stay: true };
          }
          throw error;
        }
      },
    },
  };

  async complete(ctx: BotContext, d: ReviewData): Promise<void> {
    if (!ctx.actor) return;
    try {
      await this.review.execute(ctx.actor.actor, {
        submissionId: d.submissionId,
        decision: d.decision,
        comment: d.comment,
        fileIds: d.fileIds,
      });
      await renderMenu(
        ctx,
        ctx.t(d.decision === 'accepted' ? 'review-accepted' : 'review-returned'),
        this.back(ctx, d),
      );
    } catch (error) {
      if (isTerminalFlowError(error)) ctx.session.flow = undefined;
      throw error;
    }
  }
}
