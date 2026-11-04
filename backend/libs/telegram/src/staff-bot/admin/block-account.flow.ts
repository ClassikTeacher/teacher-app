import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { BlockAccountUseCase } from '@modules/identity/block-account.use-case.js';
import type { BotContext } from '../../core/context.js';
import { Flow, flowCb, type FlowStep } from '../../core/flow.js';
import { escapeHtml, renderMenu, say } from '../../core/ui.js';
import { fullName } from './format.js';

export interface BlockAccountData extends Record<string, unknown> {
  targetId: string;
  targetName: string;
  isTeacherOrStudent: boolean;
  reason: string;
  policy: 'cancel' | 'keep';
  message: string;
  /** callback_data of the screen to return to afterwards. */
  backTo: string;
}

const MAX_TEXT = 500;

/** UC-08 / ACC-01, ACC-02: reason → fate of future lessons (teachers and students) → message → confirm. */
@Injectable()
export class BlockAccountFlow extends Flow<BlockAccountData> {
  readonly name = 'block-account';
  readonly firstStep = 'reason';

  constructor(
    private readonly accounts: AccountRepository,
    private readonly block: BlockAccountUseCase,
  ) {
    super();
  }

  async initial(_ctx: BotContext, arg: unknown): Promise<BlockAccountData> {
    const start = arg as { targetId: string; backTo: string };
    const target = await this.accounts.findById(start.targetId);
    const roles = target ? await this.accounts.activeRoles(target.id) : [];
    return {
      targetId: start.targetId,
      targetName: target ? fullName(target) : '',
      isTeacherOrStudent: roles.includes('TEACHER') || roles.includes('STUDENT'),
      reason: '',
      policy: 'keep',
      message: '',
      backTo: start.backTo,
    };
  }

  readonly steps: Record<string, FlowStep<BlockAccountData>> = {
    reason: {
      enter: async (ctx, d) => {
        const kb = new InlineKeyboard().text(ctx.t('btn-cancel'), flowCb('reason', 'cancel'));
        await renderMenu(ctx, ctx.t('block-reason', { name: escapeHtml(d.targetName) }), kb);
      },
      onCallback: async (ctx, _d, action) => {
        if (action === 'cancel') {
          ctx.session.flow = undefined;
          await say(ctx, ctx.t('cancel-done'));
        }
        return { stay: true };
      },
      onText: async (ctx, d, text) => {
        if (!text || text.length > MAX_TEXT) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_TEXT }));
          return { stay: true };
        }
        d.reason = text;
        return { goto: d.isTeacherOrStudent ? 'policy' : 'confirm' };
      },
    },
    policy: {
      enter: async (ctx) => {
        const kb = new InlineKeyboard()
          .text(ctx.t('btn-lessons-cancel'), flowCb('policy', 'cancel'))
          .row()
          .text(ctx.t('btn-lessons-keep'), flowCb('policy', 'keep'));
        await renderMenu(ctx, ctx.t('block-policy'), kb);
      },
      onCallback: async (_ctx, d, action) => {
        if (action === 'cancel') {
          d.policy = 'cancel';
          return { goto: 'message' };
        }
        if (action === 'keep') {
          d.policy = 'keep';
          return { goto: 'confirm' };
        }
        return { stay: true };
      },
    },
    message: {
      enter: async (ctx) => renderMenu(ctx, ctx.t('block-message')),
      onText: async (ctx, d, text) => {
        if (!text || text.length > MAX_TEXT) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_TEXT }));
          return { stay: true };
        }
        d.message = text;
        return { goto: 'confirm' };
      },
    },
    confirm: {
      enter: async (ctx, d) => {
        const kb = new InlineKeyboard()
          .text(ctx.t('btn-confirm-block'), flowCb('confirm', 'ok'))
          .text(ctx.t('btn-cancel'), flowCb('confirm', 'cancel'));
        const policy = d.isTeacherOrStudent ? ctx.t(`block-policy-${d.policy}`) : ctx.t('block-policy-none');
        await renderMenu(
          ctx,
          ctx.t('block-confirm', { name: escapeHtml(d.targetName), reason: escapeHtml(d.reason), policy }),
          kb,
        );
      },
      onCallback: async (ctx, _d, action) => {
        if (action === 'ok') return { done: true };
        if (action === 'cancel') {
          ctx.session.flow = undefined;
          await say(ctx, ctx.t('cancel-done'));
        }
        return { stay: true };
      },
    },
  };

  async complete(ctx: BotContext, d: BlockAccountData): Promise<void> {
    if (!ctx.actor) return;
    await this.block.block(ctx.actor.actor, d.targetId, {
      reason: d.reason,
      lessonsPolicy: d.isTeacherOrStudent ? d.policy : 'keep',
      message: d.policy === 'cancel' ? d.message : null,
    });
    const kb = new InlineKeyboard().text(ctx.t('btn-back'), d.backTo);
    await renderMenu(ctx, ctx.t('block-done', { name: escapeHtml(d.targetName) }), kb);
  }
}
