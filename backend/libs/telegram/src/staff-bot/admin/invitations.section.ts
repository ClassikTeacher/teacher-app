import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import type { Actor } from '@modules/access/actor.js';
import { InviteStaffUseCase } from '@modules/identity/invite-staff.use-case.js';
import type { BotContext } from '../../core/context.js';
import { escapeHtml, renderMenu } from '../../core/ui.js';
import { sectionCb, type StaffSectionModule } from '../section-module.js';
import { InviteTeacherFlow } from './invite-teacher.flow.js';

/** Admin → Приглашения: pending links issued by this admin, with revoke (INV-02). */
@Injectable()
export class InvitationsSection implements StaffSectionModule {
  readonly section = 'invitations' as const;

  constructor(
    private readonly invite: InviteStaffUseCase,
    private readonly inviteFlow: InviteTeacherFlow,
  ) {}

  async open(ctx: BotContext, actor: Actor): Promise<void> {
    const pending = await this.invite.listPending(actor);
    const kb = new InlineKeyboard();
    const lines = pending.map((inv, i) => {
      const name = inv.payload.displayName
        ? escapeHtml(inv.payload.displayName)
        : ctx.t('invite-teacher-noname');
      kb.text(`🗑 ${i + 1}`, sectionCb('invitations', 'revoke', inv.id));
      if (i % 4 === 3) kb.row();
      return `${i + 1}. ${name} · ${ctx.t(`role-${inv.kind}`)} · ${ctx.t('invite-until')} ${inv.expiresAt.toISOString().slice(0, 10)}`;
    });
    if (pending.length % 4 !== 0) kb.row();
    kb.text(ctx.t('btn-invite-teacher'), sectionCb('invitations', 'invite')).row();
    kb.text(ctx.t('btn-back'), 'm:admin');
    const body = lines.length > 0 ? lines.join('\n') : ctx.t('invitations-empty');
    await renderMenu(ctx, `${ctx.t('invitations-title')}\n\n${body}`, kb);
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    if (action === 'invite') return this.inviteFlow.start(ctx, { role: 'TEACHER' });
    if (action === 'revoke' && args[0]) {
      await this.invite.revoke(actor, args[0]);
      await ctx.answerCallbackQuery({ text: ctx.t('invite-revoked-ok') }).catch(() => undefined);
    }
    return this.open(ctx, actor);
  }
}
