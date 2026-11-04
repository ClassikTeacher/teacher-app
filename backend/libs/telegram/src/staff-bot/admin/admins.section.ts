import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import type { Actor } from '@modules/access/actor.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { AdminRoleUseCase } from '@modules/identity/admin-role.use-case.js';
import type { BotContext } from '../../core/context.js';
import { renderMenu } from '../../core/ui.js';
import { sectionCb, type StaffSectionModule } from '../section-module.js';
import { accountLabel } from './format.js';

/** SA → Администраторы: list admins, revoke; granting happens from a teacher card (UC-03). */
@Injectable()
export class AdminsSection implements StaffSectionModule {
  readonly section = 'admins' as const;

  constructor(
    private readonly accounts: AccountRepository,
    private readonly adminRole: AdminRoleUseCase,
  ) {}

  async open(ctx: BotContext, _actor: Actor): Promise<void> {
    const { items } = await this.accounts.listByRole('ADMIN', { page: 1, limit: 50 });
    const kb = new InlineKeyboard();
    for (const a of items) kb.text(`🗑 ${accountLabel(a)}`, sectionCb('admins', 'revoke', a.id)).row();
    kb.text(ctx.t('btn-back'), 'm:admin');
    await renderMenu(ctx, ctx.t('admins-list', { total: items.length }), kb);
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    const id = args[0];
    if (action === 'grant' && id) {
      await this.adminRole.grant(actor, id);
      await ctx.answerCallbackQuery({ text: ctx.t('admin-granted') }).catch(() => undefined);
    } else if (action === 'revoke' && id) {
      await this.adminRole.revoke(actor, id);
      await ctx.answerCallbackQuery({ text: ctx.t('admin-revoked') }).catch(() => undefined);
    }
    return this.open(ctx, actor);
  }
}
