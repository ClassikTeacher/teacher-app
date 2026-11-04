import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import type { Actor } from '@modules/access/actor.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { BlockAccountUseCase } from '@modules/identity/block-account.use-case.js';
import type { CreatedBot } from '../../core/bot-factory.js';
import type { BotContext } from '../../core/context.js';
import { Flow, type FlowStep } from '../../core/flow.js';
import { renderMenu, say } from '../../core/ui.js';
import { sectionCb, type StaffSectionModule } from '../section-module.js';
import { BlockAccountFlow } from './block-account.flow.js';
import { accountCard, accountLabel } from './format.js';

export interface UserSearchData extends Record<string, unknown> {
  query: string;
}

/** Search dialog: one text step. */
@Injectable()
export class UserSearchFlow extends Flow<UserSearchData> {
  readonly name = 'user-search';
  readonly firstStep = 'query';

  constructor(private readonly accounts: AccountRepository) {
    super();
  }

  async initial(): Promise<UserSearchData> {
    return { query: '' };
  }

  readonly steps: Record<string, FlowStep<UserSearchData>> = {
    query: {
      enter: async (ctx) =>
        renderMenu(
          ctx,
          ctx.t('users-search-prompt'),
          new InlineKeyboard().text(ctx.t('btn-back'), 'm:admin'),
        ),
      onText: async (ctx, d, text) => {
        if (text.length < 2 || text.length > 60) {
          await say(ctx, ctx.t('users-search-invalid'));
          return { stay: true };
        }
        d.query = text;
        return { done: true };
      },
    },
  };

  async complete(ctx: BotContext, d: UserSearchData): Promise<void> {
    const found = await this.accounts.search(d.query);
    const kb = new InlineKeyboard();
    for (const a of found) kb.text(accountLabel(a), sectionCb('users', 'card', a.id)).row();
    kb.text(ctx.t('btn-search-again'), sectionCb('users', 'search')).row();
    kb.text(ctx.t('btn-back'), 'm:admin');
    await renderMenu(
      ctx,
      ctx.t(found.length > 0 ? 'users-search-results' : 'users-search-empty', { count: found.length }),
      kb,
    );
  }
}

/** Admin → Пользователи: search by name or username, card, block/unblock (UC-08 for students and parents). */
@Injectable()
export class UsersSection implements StaffSectionModule {
  readonly section = 'users' as const;

  constructor(
    private readonly accounts: AccountRepository,
    private readonly blockAccount: BlockAccountUseCase,
    private readonly searchFlow: UserSearchFlow,
    private readonly blockFlow: BlockAccountFlow,
  ) {}

  register({ flows }: CreatedBot): void {
    flows.register(this.searchFlow);
  }

  async open(ctx: BotContext, _actor: Actor): Promise<void> {
    await this.searchFlow.start(ctx);
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    const id = args[0];
    switch (action) {
      case 'search':
        return this.searchFlow.start(ctx);
      case 'card':
        return id ? this.card(ctx, id) : this.open(ctx, actor);
      case 'block':
        return id
          ? this.blockFlow.start(ctx, { targetId: id, backTo: sectionCb('users', 'card', id) })
          : undefined;
      case 'unblock':
        if (!id) return;
        await this.blockAccount.unblock(actor, id);
        return this.card(ctx, id);
      default:
        return this.open(ctx, actor);
    }
  }

  private async card(ctx: BotContext, id: string): Promise<void> {
    const account = await this.accounts.findById(id);
    if (!account) return;
    const roles = await this.accounts.activeRoles(id);
    const kb = new InlineKeyboard();
    if (account.status === 'blocked') kb.text(ctx.t('btn-unblock'), sectionCb('users', 'unblock', id)).row();
    else if (!roles.includes('SUPER_ADMIN'))
      kb.text(ctx.t('btn-block'), sectionCb('users', 'block', id)).row();
    kb.text(ctx.t('btn-search-again'), sectionCb('users', 'search')).row();
    kb.text(ctx.t('btn-back'), 'm:admin');
    await renderMenu(ctx, accountCard(ctx, { ...account, roles }), kb);
  }
}
