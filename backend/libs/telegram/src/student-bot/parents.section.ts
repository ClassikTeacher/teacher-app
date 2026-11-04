import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import type { Actor } from '@modules/access/actor.js';
import { FamilyQuery } from '@modules/people/family/family.query.js';
import type { BotContext } from '../core/context.js';
import type { SectionModule } from '../core/sections.js';
import { renderMenu } from '../core/ui.js';
import { parentLine } from '../person/format.js';
import { backToMain } from '../person/person-menu.js';
import type { StudentSection } from './sections.js';

/** StudentBot → Родители: read-only list (3.5: the student neither invites nor removes parents). */
@Injectable()
export class StudentParentsSection implements SectionModule<StudentSection> {
  readonly section = 'parents' as const;

  constructor(private readonly family: FamilyQuery) {}

  async open(ctx: BotContext, actor: Actor): Promise<void> {
    const parents = await this.family.parentsOf(actor.accountId);
    const lines = parents.map(({ parent }) => `• ${parentLine(parent)}`);
    const body = lines.length > 0 ? lines.join('\n') : ctx.t('student-parents-empty');
    await renderMenu(
      ctx,
      `${ctx.t('student-parents-title')}\n\n${body}\n\n${ctx.t('student-parents-note')}`,
      backToMain(ctx),
    );
  }

  backKeyboard(ctx: BotContext): InlineKeyboard {
    return backToMain(ctx);
  }
}
