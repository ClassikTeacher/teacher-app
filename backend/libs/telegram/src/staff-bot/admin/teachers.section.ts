import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { type Actor, isSuperAdmin } from '@modules/access/actor.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { BlockAccountUseCase } from '@modules/identity/block-account.use-case.js';
import type { CreatedBot } from '../../core/bot-factory.js';
import type { BotContext } from '../../core/context.js';
import { renderMenu } from '../../core/ui.js';
import { backKeyboard } from '../menu.js';
import { sectionCb, type StaffSectionModule } from '../section-module.js';
import { BlockAccountFlow } from './block-account.flow.js';
import { accountCard, accountLabel, pageLabel } from './format.js';
import { InviteTeacherFlow } from './invite-teacher.flow.js';

const PAGE_SIZE = 8;

/** Admin → Учителя: list, card, invite, block/unblock, (SA) admin role (UC-04, UC-08, UC-03). */
@Injectable()
export class TeachersSection implements StaffSectionModule {
  readonly section = 'teachers' as const;

  constructor(
    private readonly accounts: AccountRepository,
    private readonly blockAccount: BlockAccountUseCase,
    private readonly inviteFlow: InviteTeacherFlow,
    private readonly blockFlow: BlockAccountFlow,
  ) {}

  register({ flows }: CreatedBot): void {
    flows.register(this.inviteFlow).register(this.blockFlow);
  }

  async open(ctx: BotContext, _actor: Actor, page = 1): Promise<void> {
    const { items, total } = await this.accounts.listByRole('TEACHER', { page, limit: PAGE_SIZE });
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const kb = new InlineKeyboard();
    for (const t of items) kb.text(accountLabel(t), sectionCb('teachers', 'card', t.id)).row();
    if (pages > 1) {
      if (page > 1) kb.text('◀️', sectionCb('teachers', 'page', page - 1));
      kb.text(pageLabel(page, pages), sectionCb('teachers', 'noop'));
      if (page < pages) kb.text('▶️', sectionCb('teachers', 'page', page + 1));
      kb.row();
    }
    kb.text(ctx.t('btn-invite-teacher'), sectionCb('teachers', 'invite')).row();
    kb.text(ctx.t('btn-back'), 'm:admin');
    await renderMenu(ctx, ctx.t('teachers-list', { total }), kb);
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    const id = args[0];
    switch (action) {
      case 'page':
        return this.open(ctx, actor, Math.max(1, Math.trunc(Number(id)) || 1));
      case 'invite':
        return this.inviteFlow.start(ctx, { role: 'TEACHER' });
      case 'card':
        return id ? this.card(ctx, actor, id) : this.open(ctx, actor);
      case 'block':
        return id
          ? this.blockFlow.start(ctx, { targetId: id, backTo: sectionCb('teachers', 'card', id) })
          : undefined;
      case 'unblock':
        if (!id) return;
        await this.blockAccount.unblock(actor, id);
        return this.card(ctx, actor, id);
      default:
        return this.open(ctx, actor);
    }
  }

  async card(ctx: BotContext, actor: Actor, id: string): Promise<void> {
    const account = await this.accounts.findById(id);
    const roles = account ? await this.accounts.activeRoles(id) : [];
    if (!account || !roles.includes('TEACHER')) return this.open(ctx, actor); // other accounts live in "Пользователи"
    const kb = new InlineKeyboard();
    kb.text(ctx.t('btn-features'), sectionCb('features', 'teacher', id)).row();
    if (account.status === 'blocked')
      kb.text(ctx.t('btn-unblock'), sectionCb('teachers', 'unblock', id)).row();
    else if (!roles.includes('SUPER_ADMIN'))
      kb.text(ctx.t('btn-block'), sectionCb('teachers', 'block', id)).row();
    if (isSuperAdmin(actor) && account.status === 'active' && !roles.includes('SUPER_ADMIN')) {
      if (roles.includes('ADMIN'))
        kb.text(ctx.t('btn-revoke-admin'), sectionCb('admins', 'revoke', id)).row();
      else kb.text(ctx.t('btn-grant-admin'), sectionCb('admins', 'grant', id)).row();
    }
    kb.text(ctx.t('btn-back'), sectionCb('teachers', 'list'));
    await renderMenu(ctx, accountCard(ctx, { ...account, roles }), kb);
  }

  backToList(ctx: BotContext): InlineKeyboard {
    return backKeyboard(ctx, 'admin');
  }
}
