import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import type { Actor } from '@modules/access/actor.js';
import type { CreatedBot } from '../core/bot-factory.js';
import type { BotContext } from '../core/context.js';
import type { SectionModule } from '../core/sections.js';
import { renderMenu } from '../core/ui.js';
import { ProgressScreen, type ProgressSubject } from '../person/progress.screen.js';
import { ChildrenSection } from './children.section.js';
import type { ParentSection } from './sections.js';

/** ParentBot → 📊 Успеваемость и отчёты (UC-36): the selected child's journals and reports; a parent may report a school mark too (UC-30). */
@Injectable()
export class ParentProgressSection implements SectionModule<ParentSection> {
  readonly section = 'progress' as const;

  constructor(
    private readonly screen: ProgressScreen,
    private readonly children: ChildrenSection,
  ) {}

  register({ flows }: CreatedBot): void {
    flows.register(this.screen.flow);
  }

  private async who(ctx: BotContext, actor: Actor): Promise<ProgressSubject | null> {
    const child = await this.children.selectedChild(ctx, actor.accountId);
    return child ? { side: 'parent', child } : null;
  }

  async open(ctx: BotContext, actor: Actor): Promise<void> {
    const who = await this.who(ctx, actor);
    if (!who)
      return renderMenu(
        ctx,
        ctx.t('parent-children-empty'),
        new InlineKeyboard().text(ctx.t('btn-back'), 'm:main'),
      );
    await this.screen.root(ctx, actor, this.section, who);
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    const who = await this.who(ctx, actor);
    if (!who) return this.open(ctx, actor);
    const id = args[0] ?? '';
    switch (action) {
      case 'j': // also the «Открыть журнал» button of a copied grade.added
        return this.screen.journal(ctx, actor, this.section, who, id);
      case 'propose':
        return this.screen.startPropose(ctx, actor, this.section, who, id);
      case 'reports':
        return this.screen.reports(ctx, actor, this.section, who);
      case 'r': // also the «Открыть отчёт» button of the report copy
        return this.screen.report(ctx, actor, this.section, who, id);
      default:
        return this.open(ctx, actor);
    }
  }
}
