import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import type { Actor } from '@modules/access/actor.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import type { AccountRow } from '@modules/identity/schema.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { RevokeFamilyLinkUseCase } from '@modules/people/family/revoke-family-link.use-case.js';
import type { BotContext } from '../core/context.js';
import { clip, fullName } from '../core/format.js';
import { type SectionModule, sectionCb } from '../core/sections.js';
import { escapeHtml, renderMenu } from '../core/ui.js';
import { type ParentSection, SELECTED_CHILD_KEY } from './sections.js';

/** ParentBot → Дети: the parent's children with a switch; the selection lives in the session (5.4.3). */
@Injectable()
export class ChildrenSection implements SectionModule<ParentSection> {
  readonly section = 'children' as const;

  constructor(
    private readonly family: FamilyLinkRepository,
    private readonly accounts: AccountRepository,
    private readonly revoke: RevokeFamilyLinkUseCase,
  ) {}

  /** Children the parent is actively linked to, in link order. */
  async childrenOf(parentId: string): Promise<AccountRow[]> {
    const links = await this.family.listActiveByParent(parentId);
    const byId = new Map(
      (await this.accounts.findByIds(links.map((l) => l.studentId))).map((a) => [a.id, a]),
    );
    return links.map((l) => byId.get(l.studentId)).filter((a): a is AccountRow => a !== undefined);
  }

  /** The currently selected child, defaulting to the only (or first) one; null when there are none. */
  async selectedChild(ctx: BotContext, parentId: string): Promise<AccountRow | null> {
    const children = await this.childrenOf(parentId);
    const wanted = ctx.session.scratch?.[SELECTED_CHILD_KEY];
    return children.find((c) => c.id === wanted) ?? children[0] ?? null;
  }

  async open(ctx: BotContext, actor: Actor): Promise<void> {
    const children = await this.childrenOf(actor.accountId);
    const selected = await this.selectedChild(ctx, actor.accountId);
    const kb = new InlineKeyboard();
    for (const child of children) {
      const mark = child.id === selected?.id ? '✅ ' : '';
      kb.text(`${mark}${clip(fullName(child))}`, sectionCb('children', 'select', child.id)).row();
    }
    if (selected) kb.text(ctx.t('btn-unlink-child'), sectionCb('children', 'unlink', selected.id)).row();
    kb.text(ctx.t('btn-back'), 'm:main');
    const text =
      children.length === 0
        ? ctx.t('parent-children-empty')
        : ctx.t('parent-children-list', { child: escapeHtml(selected ? fullName(selected) : '—') });
    await renderMenu(ctx, text, kb);
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    const id = args[0];
    if (action === 'select' && id) {
      const children = await this.childrenOf(actor.accountId);
      if (children.some((c) => c.id === id)) {
        ctx.session.scratch = { ...(ctx.session.scratch ?? {}), [SELECTED_CHILD_KEY]: id };
      }
    } else if (action === 'unlink' && id) {
      // 5.4.3: a parent may revoke their own link; confirmation screen first
      const child = (await this.childrenOf(actor.accountId)).find((c) => c.id === id);
      if (!child) return this.open(ctx, actor);
      const kb = new InlineKeyboard()
        .text(ctx.t('btn-confirm-unlink'), sectionCb('children', 'unlinkok', id))
        .text(ctx.t('btn-cancel'), sectionCb('children', 'list'));
      return renderMenu(ctx, ctx.t('parent-unlink-confirm', { child: escapeHtml(fullName(child)) }), kb);
    } else if (action === 'unlinkok' && id) {
      const link = await this.family.findActive(actor.accountId, id);
      // the teacher may have revoked it meanwhile: a vanished or already revoked link is not an error here
      if (link) {
        try {
          await this.revoke.execute(actor, link.id);
        } catch (error) {
          if (!AppError.is(error, 'CONFLICT')) throw error;
        }
      }
      ctx.session.scratch = { ...(ctx.session.scratch ?? {}), [SELECTED_CHILD_KEY]: undefined };
    }
    return this.open(ctx, actor);
  }
}
