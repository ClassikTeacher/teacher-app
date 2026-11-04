import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { EndLinkUseCase } from '@modules/people/links/end-link.use-case.js';
import { MAX_END_MESSAGE_LENGTH } from '@modules/people/links/link.rules.js';
import type { BotContext } from '../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../core/flow.js';
import { sectionCb } from '../core/sections.js';
import { escapeHtml, renderMenu, say } from '../core/ui.js';
import { isTerminalFlowError } from '../staff-bot/common/flow-errors.js';

export interface ParentEndData extends Record<string, unknown> {
  linkId: string;
  teacherName: string;
  childName: string;
  message: string;
}

/** 5.8.3: parent → child → teacher → "Завершить занятия" → message → confirm; reason `ended_by_parent`. */
@Injectable()
export class ParentEndLinkFlow extends Flow<ParentEndData> {
  readonly name = 'parent-end-link';
  readonly firstStep = 'message';

  constructor(private readonly endLink: EndLinkUseCase) {
    super();
  }

  async initial(_ctx: BotContext, arg: unknown): Promise<ParentEndData> {
    const start = arg as { linkId: string; teacherName: string; childName: string };
    return { linkId: start.linkId, teacherName: start.teacherName, childName: start.childName, message: '' };
  }

  private async cancel(ctx: BotContext, d: ParentEndData): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(
      ctx,
      ctx.t('cancel-done'),
      new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('teachers', 'card', d.linkId)),
    );
    return { stay: true };
  }

  readonly steps: Record<string, FlowStep<ParentEndData>> = {
    message: {
      enter: async (ctx, d) =>
        renderMenu(
          ctx,
          ctx.t('parent-end-message', { teacher: escapeHtml(d.teacherName), child: escapeHtml(d.childName) }),
          new InlineKeyboard().text(ctx.t('btn-cancel'), flowCb('message', 'cancel')),
        ),
      onCallback: async (ctx, d, action) => (action === 'cancel' ? this.cancel(ctx, d) : { stay: true }),
      onText: async (ctx, d, text) => {
        if (!text || text.length > MAX_END_MESSAGE_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_END_MESSAGE_LENGTH }));
          return { stay: true };
        }
        d.message = text;
        return { goto: 'confirm' };
      },
    },
    confirm: {
      enter: async (ctx, d) =>
        renderMenu(
          ctx,
          ctx.t('parent-end-confirm', {
            teacher: escapeHtml(d.teacherName),
            child: escapeHtml(d.childName),
            message: escapeHtml(d.message),
          }),
          new InlineKeyboard()
            .text(ctx.t('btn-confirm-end-link'), flowCb('confirm', 'ok'))
            .text(ctx.t('btn-cancel'), flowCb('confirm', 'cancel')),
        ),
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.cancel(ctx, d);
        return action === 'ok' ? { done: true } : { stay: true };
      },
    },
  };

  async complete(ctx: BotContext, d: ParentEndData): Promise<void> {
    if (!ctx.actor) return;
    try {
      await this.endLink.execute(ctx.actor.actor, d.linkId, {
        reason: 'ended_by_parent',
        message: d.message,
      });
    } catch (error) {
      if (isTerminalFlowError(error)) ctx.session.flow = undefined;
      throw error;
    }
    await renderMenu(
      ctx,
      ctx.t('parent-end-done', { teacher: escapeHtml(d.teacherName), child: escapeHtml(d.childName) }),
      new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('teachers', 'list')),
    );
  }
}
