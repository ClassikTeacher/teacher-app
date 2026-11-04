import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import type { Actor } from '@modules/access/actor.js';
import { IcsUseCase } from '@modules/integrations/ics.use-case.js';
import { cb } from '../core/callback.js';
import type { BotContext } from '../core/context.js';
import { SECTION_NS } from '../core/sections.js';
import { escapeHtml, renderMenu } from '../core/ui.js';

/**
 * «📅 Календарь (ICS)» in the settings of the three bots (5.14.2): explains the subscription, issues the link
 * (shown once — the token is not stored), re-issues it on request. Callbacks: `s:<section>:ics` / `icsrot`.
 */
@Injectable()
export class IcsScreen {
  constructor(private readonly ics: IcsUseCase) {}

  /** Returns false for an action this screen does not own. */
  async handle(
    ctx: BotContext,
    actor: Actor,
    section: string,
    action: string,
    backCb: string,
  ): Promise<boolean> {
    if (action !== 'ics' && action !== 'icsrot') return false;
    const kb = new InlineKeyboard();
    try {
      if (action === 'icsrot') {
        const url = await this.ics.rotate(actor);
        kb.text(ctx.t('btn-ics-rotate'), cb(SECTION_NS, section, 'icsrot'))
          .row()
          .text(ctx.t('btn-back'), backCb);
        await renderMenu(ctx, ctx.t('ics-link', { url: escapeHtml(url) }), kb);
        return true;
      }
      const has = await this.ics.hasLink(actor);
      kb.text(ctx.t(has ? 'btn-ics-rotate' : 'btn-ics-issue'), cb(SECTION_NS, section, 'icsrot'))
        .row()
        .text(ctx.t('btn-back'), backCb);
      await renderMenu(ctx, ctx.t(has ? 'ics-intro-has' : 'ics-intro'), kb);
    } catch (error) {
      if (!AppError.is(error, 'FEATURE_DISABLED')) throw error;
      await renderMenu(
        ctx,
        ctx.t('error-feature-disabled'),
        new InlineKeyboard().text(ctx.t('btn-back'), backCb),
      );
    }
    return true;
  }
}
