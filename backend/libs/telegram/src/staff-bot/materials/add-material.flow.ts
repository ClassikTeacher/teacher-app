import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import {
  MaterialsUseCase,
  MAX_BODY_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_URL_LENGTH,
} from '@modules/content/materials.use-case.js';
import type { BotContext } from '../../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../../core/flow.js';
import { escapeHtml, renderMenu, say } from '../../core/ui.js';
import { isTerminalFlowError } from '../common/flow-errors.js';
import { sectionCb } from '../section-module.js';
import { GrantFlow } from './grant.flow.js';

export interface AddMaterialData extends Record<string, unknown> {
  kind: 'link' | 'text';
  content: string | null;
  title: string | null;
}

/** 5.9.1: a link or a text note → title → library → «кому выдать». */
@Injectable()
export class AddMaterialFlow extends Flow<AddMaterialData> {
  readonly name = 'add-material';
  readonly firstStep = 'content';

  constructor(
    private readonly materials: MaterialsUseCase,
    private readonly grantFlow: GrantFlow,
  ) {
    super();
  }

  async initial(_ctx: BotContext, arg: unknown): Promise<AddMaterialData> {
    return { kind: (arg as { kind: 'link' | 'text' }).kind, content: null, title: null };
  }

  private async cancel(ctx: BotContext): Promise<FlowNext> {
    ctx.session.flow = undefined;
    const back = new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('materials', 'list'));
    await renderMenu(ctx, ctx.t('cancel-done'), back);
    return { stay: true };
  }

  readonly steps: Record<string, FlowStep<AddMaterialData>> = {
    content: {
      enter: async (ctx, d) =>
        renderMenu(
          ctx,
          ctx.t(d.kind === 'link' ? 'addlink-ask-url' : 'addtext-ask-body'),
          new InlineKeyboard().text(ctx.t('btn-cancel'), flowCb('content', 'cancel')),
        ),
      onCallback: async (ctx, _d, action) => (action === 'cancel' ? this.cancel(ctx) : { stay: true }),
      onText: async (ctx, d, text) => {
        const max = d.kind === 'link' ? MAX_URL_LENGTH : MAX_BODY_LENGTH;
        if (!text || text.length > max) {
          await say(ctx, ctx.t('text-too-long', { max }));
          return { stay: true };
        }
        if (d.kind === 'link' && !/^https?:\/\/\S+$/i.test(text)) {
          await say(ctx, ctx.t('addlink-bad-url'));
          return { stay: true };
        }
        d.content = text;
        return { goto: 'title' };
      },
    },
    title: {
      enter: async (ctx) =>
        renderMenu(
          ctx,
          ctx.t('add-ask-title'),
          new InlineKeyboard().text(ctx.t('btn-cancel'), flowCb('title', 'cancel')),
        ),
      onCallback: async (ctx, _d, action) => (action === 'cancel' ? this.cancel(ctx) : { stay: true }),
      onText: async (ctx, d, text) => {
        if (!text || text.length > MAX_TITLE_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_TITLE_LENGTH }));
          return { stay: true };
        }
        d.title = text;
        return { done: true };
      },
    },
  };

  async complete(ctx: BotContext, d: AddMaterialData): Promise<void> {
    if (!ctx.actor || !d.content || !d.title) {
      ctx.session.flow = undefined;
      return;
    }
    try {
      const row = await this.materials.create(
        ctx.actor.actor,
        d.kind === 'link'
          ? { kind: 'link', title: d.title, url: d.content }
          : { kind: 'text', title: d.title, body: d.content },
      );
      ctx.session.flow = undefined; // created: a failure in the hand-over must not retry `create`
      await say(ctx, ctx.t('upload-done', { title: escapeHtml(row.title) }));
      await this.grantFlow.start(ctx, {
        subjectType: 'material',
        subjectId: row.id,
        title: row.title,
        optional: true,
      });
    } catch (error) {
      if (AppError.is(error, 'VALIDATION_ERROR') && error.details?.['field'] === 'url') {
        await say(ctx, ctx.t('addlink-bad-url'));
        return;
      }
      if (isTerminalFlowError(error)) ctx.session.flow = undefined;
      throw error;
    }
  }
}
