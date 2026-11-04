import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import type { Actor } from '@modules/access/actor.js';
import { FamilyQuery } from '@modules/people/family/family.query.js';
import type { CreatedBot } from '../core/bot-factory.js';
import type { BotContext } from '../core/context.js';
import { clip, fullName } from '../core/format.js';
import { type SectionModule, sectionCb } from '../core/sections.js';
import { escapeHtml, renderMenu } from '../core/ui.js';
import { backToMain } from '../person/person-menu.js';
import { ChildrenSection } from './children.section.js';
import { ParentEndLinkFlow } from './end-link.flow.js';
import type { ParentSection } from './sections.js';

/**
 * ParentBot → Учителя ребёнка (4.4): teachers of the selected child with subjects; the card offers
 * "Написать учителю". "Завершить занятия" arrives with M2-06.
 */
@Injectable()
export class ParentTeachersSection implements SectionModule<ParentSection> {
  readonly section = 'teachers' as const;

  constructor(
    private readonly family: FamilyQuery,
    private readonly children: ChildrenSection,
    private readonly endFlow: ParentEndLinkFlow,
  ) {}

  register({ flows }: CreatedBot): void {
    flows.register(this.endFlow);
  }

  async open(ctx: BotContext, actor: Actor): Promise<void> {
    const child = await this.children.selectedChild(ctx, actor.accountId);
    if (!child) return renderMenu(ctx, ctx.t('parent-children-empty'), backToMain(ctx));
    const items = await this.family.teachersOfChild(child.id, child.status);
    const kb = new InlineKeyboard();
    for (const item of items) {
      kb.text(clip(fullName(item.teacher)), sectionCb('teachers', 'card', item.link.id)).row();
    }
    kb.text(ctx.t('btn-back'), 'm:main');
    const key = items.length > 0 ? 'parent-teachers-list' : 'parent-teachers-empty';
    await renderMenu(ctx, ctx.t(key, { child: escapeHtml(fullName(child)) }), kb);
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    if (action === 'card' && args[0]) return this.card(ctx, actor, args[0]);
    if (action === 'end' && args[0]) return this.end(ctx, actor, args[0]);
    return this.open(ctx, actor);
  }

  private async card(ctx: BotContext, actor: Actor, linkId: string): Promise<void> {
    const child = await this.children.selectedChild(ctx, actor.accountId);
    if (!child) return this.open(ctx, actor);
    // 8.0: the link must belong to the selected child, who must be this parent's child
    const item = (await this.family.teachersOfChild(child.id, child.status)).find(
      (i) => i.link.id === linkId,
    );
    if (!item) return this.open(ctx, actor);
    const kb = new InlineKeyboard();
    if (item.teacher.username)
      kb.url(ctx.t('btn-write-teacher'), `https://t.me/${item.teacher.username}`).row();
    kb.text(ctx.t('btn-end-link'), sectionCb('teachers', 'end', item.link.id)).row();
    kb.text(ctx.t('btn-back'), sectionCb('teachers', 'list'));
    await renderMenu(
      ctx,
      ctx.t('parent-teacher-card', {
        teacher: escapeHtml(fullName(item.teacher)),
        child: escapeHtml(fullName(child)),
        subjects: escapeHtml(item.subjects.map((s) => s.name).join(', ') || '—'),
      }),
      kb,
    );
  }

  /** 5.8.3: the selected child's link only (the use-case re-checks the parent context). */
  private async end(ctx: BotContext, actor: Actor, linkId: string): Promise<void> {
    const child = await this.children.selectedChild(ctx, actor.accountId);
    const item = child ? await this.family.teacherOfChild(child.id, child.status, linkId) : null;
    if (!child || !item) return this.open(ctx, actor);
    await this.endFlow.start(ctx, {
      linkId: item.link.id,
      teacherName: fullName(item.teacher),
      childName: fullName(child),
    });
  }
}
