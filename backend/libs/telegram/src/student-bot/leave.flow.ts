import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { LeaveRequestUseCase } from '@modules/people/links/leave-request.use-case.js';
import { MAX_END_MESSAGE_LENGTH } from '@modules/people/links/link.rules.js';
import type { BotContext } from '../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../core/flow.js';
import { type SectionModule, sectionCb } from '../core/sections.js';
import { escapeHtml, renderMenu, say } from '../core/ui.js';
import { isTerminalFlowError } from '../staff-bot/common/flow-errors.js';

export interface LeaveData extends Record<string, unknown> {
  linkId: string;
  teacherName: string;
  reason: string;
  needsConsent: boolean;
}

/**
 * UC-34: "Прекратить занятия" → reason → "Вы уверены?" (LINK-01, no parent) or the request goes to the
 * parents (LINK-02). The teacher is not told about an open request (LINK-05).
 */
@Injectable()
export class LeaveFlow extends Flow<LeaveData> {
  readonly name = 'student-leave';
  readonly firstStep = 'reason';

  constructor(private readonly leaves: LeaveRequestUseCase) {
    super();
  }

  async initial(ctx: BotContext, arg: unknown): Promise<LeaveData> {
    const start = arg as { linkId: string; teacherName: string };
    const needsConsent = ctx.actor ? await this.leaves.needsConsent(ctx.actor.account.id) : false;
    return { ...start, reason: '', needsConsent };
  }

  private async cancel(ctx: BotContext, d: LeaveData): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(
      ctx,
      ctx.t('cancel-done'),
      new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('teachers', 'card', d.linkId)),
    );
    return { stay: true };
  }

  readonly steps: Record<string, FlowStep<LeaveData>> = {
    reason: {
      enter: async (ctx, d) =>
        renderMenu(
          ctx,
          ctx.t('leave-reason', { teacher: escapeHtml(d.teacherName) }),
          new InlineKeyboard().text(ctx.t('btn-cancel'), flowCb('reason', 'cancel')),
        ),
      onCallback: async (ctx, d, action) => (action === 'cancel' ? this.cancel(ctx, d) : { stay: true }),
      onText: async (ctx, d, text) => {
        if (!text || text.length > MAX_END_MESSAGE_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_END_MESSAGE_LENGTH }));
          return { stay: true };
        }
        d.reason = text;
        return { goto: 'confirm' };
      },
    },
    confirm: {
      enter: async (ctx, d) => {
        // parents may have been linked or unlinked while the reason was typed: the text follows the current state
        d.needsConsent = ctx.actor ? await this.leaves.needsConsent(ctx.actor.account.id) : d.needsConsent;
        const kb = new InlineKeyboard()
          .text(ctx.t(d.needsConsent ? 'btn-leave-send' : 'btn-leave-confirm'), flowCb('confirm', 'ok'))
          .text(ctx.t('btn-cancel'), flowCb('confirm', 'cancel'));
        await renderMenu(
          ctx,
          ctx.t(d.needsConsent ? 'leave-confirm-consent' : 'leave-confirm-direct', {
            teacher: escapeHtml(d.teacherName),
          }),
          kb,
        );
      },
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.cancel(ctx, d);
        return action === 'ok' ? { done: true } : { stay: true };
      },
    },
  };

  async complete(ctx: BotContext, d: LeaveData): Promise<void> {
    if (!ctx.actor) return;
    let outcome;
    try {
      outcome = await this.leaves.request(ctx.actor.actor, d.linkId, d.reason);
    } catch (error) {
      if (isTerminalFlowError(error)) ctx.session.flow = undefined;
      throw error;
    }
    const back = new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('teachers', 'list'));
    await renderMenu(
      ctx,
      ctx.t(outcome.kind === 'ended' ? 'leave-done' : 'leave-requested', {
        teacher: escapeHtml(d.teacherName),
      }),
      back,
    );
  }
}

export type LeaveSection = SectionModule<'teachers'>;
