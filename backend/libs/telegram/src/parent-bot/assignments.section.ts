import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { formatInZone } from '@shared/time/timezone.js';
import type { Actor } from '@modules/access/actor.js';
import { HomeworkQuery } from '@modules/homework/homework.query.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import type { BotContext } from '../core/context.js';
import { fullName } from '../core/format.js';
import { type SectionModule, sectionCb } from '../core/sections.js';
import { escapeHtml, renderMenu } from '../core/ui.js';
import { personZone } from '../person/lesson-format.js';
import { type ParentSection, SELECTED_CHILD_KEY } from './sections.js';

const WHEN = 'dd.MM HH:mm';

/** ParentBot → Задания ребёнка (4.4): read-only — what is due, what is late, what is accepted. */
@Injectable()
export class ParentAssignmentsSection implements SectionModule<ParentSection> {
  readonly section = 'assignments' as const;

  constructor(
    private readonly query: HomeworkQuery,
    private readonly family: FamilyLinkRepository,
    private readonly accounts: AccountRepository,
  ) {}

  async open(ctx: BotContext, actor: Actor): Promise<void> {
    const links = await this.family.listActiveByParent(actor.accountId);
    const selected = ctx.session.scratch?.[SELECTED_CHILD_KEY];
    const childId = links.find((l) => l.studentId === selected)?.studentId ?? links[0]?.studentId;
    const back = new InlineKeyboard().text(ctx.t('btn-back'), 'm:main');
    if (!childId) return renderMenu(ctx, ctx.t('phw-empty', { child: '', items: '' }), back);
    const child = await this.accounts.findById(childId);
    const zone = personZone(ctx);
    const items = await this.query.studentList(childId, ['assigned', 'overdue', 'returned', 'submitted']);
    const lines = items
      .slice(0, 20)
      .map((it) =>
        ctx.t('shw-line', {
          status: it.target.status,
          title: escapeHtml(it.assignment.title),
          due: it.target.dueAt ? formatInZone(it.target.dueAt, zone, WHEN) : ctx.t('hw-no-due'),
        }),
      )
      .join('\n');
    const kb = new InlineKeyboard();
    for (const l of links) {
      if (l.studentId === childId) continue;
      const other = await this.accounts.findById(l.studentId);
      if (other) kb.text(`👤 ${fullName(other)}`, sectionCb('assignments', 'child', l.studentId)).row();
    }
    kb.text(ctx.t('btn-back'), 'm:main');
    const name = escapeHtml(child ? fullName(child) : '');
    await renderMenu(
      ctx,
      ctx.t(items.length > 0 ? 'phw-list' : 'phw-empty', { child: name, items: lines }),
      kb,
    );
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    if (action === 'child' && args[0])
      ctx.session.scratch = { ...ctx.session.scratch, [SELECTED_CHILD_KEY]: args[0] };
    await this.open(ctx, actor);
  }
}
