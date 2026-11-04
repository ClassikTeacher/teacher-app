import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { InviteStaffUseCase } from '@modules/identity/invite-staff.use-case.js';
import type { BotContext } from '../../core/context.js';
import { Flow, flowCb, type FlowStep } from '../../core/flow.js';
import { escapeHtml, renderMenu, say } from '../../core/ui.js';
import { sectionCb } from '../section-module.js';

export interface InviteTeacherData extends Record<string, unknown> {
  role: 'TEACHER' | 'ADMIN';
  displayName: string;
}

const MAX_NAME = 100;

/**
 * UC-04 in the bot: optional display name → invitation card with the AuthBot link that the admin forwards.
 * Contact selection (`request_users`) is stage 2 (5.4.2); admin invitations (bound to a user) are issued via REST.
 */
@Injectable()
export class InviteTeacherFlow extends Flow<InviteTeacherData> {
  readonly name = 'invite-teacher';
  readonly firstStep = 'name';

  constructor(private readonly invite: InviteStaffUseCase) {
    super();
  }

  async initial(_ctx: BotContext, arg: unknown): Promise<InviteTeacherData> {
    const start = arg as { role: 'TEACHER' | 'ADMIN' } | undefined;
    return { role: start?.role ?? 'TEACHER', displayName: '' };
  }

  readonly steps: Record<string, FlowStep<InviteTeacherData>> = {
    name: {
      enter: async (ctx) => {
        const kb = new InlineKeyboard()
          .text(ctx.t('btn-no-name'), flowCb('name', 'skip'))
          .text(ctx.t('btn-cancel'), flowCb('name', 'cancel'));
        await renderMenu(ctx, ctx.t('invite-teacher-name'), kb);
      },
      onCallback: async (ctx, _d, action) => {
        if (action === 'cancel') {
          await say(ctx, ctx.t('cancel-done'));
          ctx.session.flow = undefined;
          return { stay: true };
        }
        return action === 'skip' ? { done: true } : { stay: true };
      },
      onText: async (ctx, d, text) => {
        if (text.length > MAX_NAME) {
          await say(ctx, ctx.t('invite-teacher-name-invalid', { max: MAX_NAME }));
          return { stay: true };
        }
        d.displayName = text;
        return { done: true };
      },
    },
  };

  async complete(ctx: BotContext, d: InviteTeacherData): Promise<void> {
    if (!ctx.actor) return;
    const issued = await this.invite.execute(ctx.actor.actor, {
      role: d.role,
      displayName: d.displayName || undefined,
    });
    const expires = issued.invitation.expiresAt.toISOString().slice(0, 10);
    const kb = new InlineKeyboard()
      .url(ctx.t('btn-open-invite-link'), issued.link)
      .row()
      .text(ctx.t('btn-revoke-invite'), sectionCb('invitations', 'revoke', issued.invitation.id))
      .row()
      .text(ctx.t('btn-back'), sectionCb('teachers', 'list'));
    // The card is a separate message so the admin can forward it as is (4.1).
    await say(
      ctx,
      ctx.t('invite-teacher-card', {
        name: escapeHtml(d.displayName || ctx.t('invite-teacher-noname')),
        link: issued.link,
        expires,
      }),
      kb,
    );
  }
}
