import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import { formatInZone } from '@shared/time/timezone.js';
import type { Actor } from '@modules/access/actor.js';
import {
  GoogleCalendarUseCase,
  type GoogleStatus,
} from '@modules/integrations/google/google-calendar.use-case.js';
import type { BotContext } from '../../core/context.js';
import { escapeHtml, renderMenu } from '../../core/ui.js';
import { sectionCb } from '../section-module.js';

const ACTIONS = new Set(['gcal', 'gcalurl', 'gcaloff', 'gcaloffy', 'gcalimp', 'gcalexp', 'gcalsync']);

/**
 * StaffBot → Настройки → «📆 Google Calendar» (UC-43, 5.14.1): status, the consent link (a URL button — the
 * browser finishes the flow and the bot gets a notification), import/export toggles, «sync now», disconnect
 * with confirmation. The section shows the button only while the feature is on (5.3.3).
 */
@Injectable()
export class GoogleScreen {
  constructor(private readonly google: GoogleCalendarUseCase) {}

  /** Returns false for an action this screen does not own. */
  async handle(ctx: BotContext, actor: Actor, action: string, backCb: string): Promise<boolean> {
    if (!ACTIONS.has(action)) return false;
    try {
      switch (action) {
        case 'gcalurl': {
          const url = await this.google.connectUrl(actor);
          const kb = new InlineKeyboard()
            .url(ctx.t('btn-google-open-consent'), url)
            .row()
            .text(ctx.t('btn-back'), sectionCb('settings', 'gcal'));
          await renderMenu(ctx, ctx.t('google-consent'), kb);
          return true;
        }
        case 'gcaloff': {
          const kb = new InlineKeyboard()
            .text(ctx.t('btn-google-disconnect-confirm'), sectionCb('settings', 'gcaloffy'))
            .row()
            .text(ctx.t('btn-back'), sectionCb('settings', 'gcal'));
          await renderMenu(ctx, ctx.t('google-disconnect-confirm'), kb);
          return true;
        }
        case 'gcaloffy':
          await this.google.disconnect(actor);
          await ctx.answerCallbackQuery({ text: ctx.t('google-disconnected') }).catch(() => undefined);
          break;
        case 'gcalimp':
        case 'gcalexp': {
          const status = await this.google.status(actor);
          if (status.connected)
            await this.google.updateSettings(
              actor,
              action === 'gcalimp'
                ? { importEnabled: !status.importEnabled }
                : { exportEnabled: !status.exportEnabled },
            );
          break;
        }
        case 'gcalsync':
          await this.google.requestSync(actor);
          await ctx.answerCallbackQuery({ text: ctx.t('google-sync-requested') }).catch(() => undefined);
          break;
        default:
          break;
      }
      await this.render(ctx, actor, backCb);
    } catch (error) {
      if (AppError.is(error, 'FEATURE_DISABLED') || AppError.is(error, 'INTEGRATION_NOT_CONFIGURED')) {
        await renderMenu(
          ctx,
          ctx.t(AppError.is(error, 'FEATURE_DISABLED') ? 'error-feature-disabled' : 'google-not-configured'),
          new InlineKeyboard().text(ctx.t('btn-back'), backCb),
        );
        return true;
      }
      if (AppError.is(error, 'NOT_FOUND')) {
        await this.render(ctx, actor, backCb); // disconnected meanwhile: show the current state
        return true;
      }
      throw error;
    }
    return true;
  }

  async render(ctx: BotContext, actor: Actor, backCb: string): Promise<void> {
    const status = await this.google.status(actor);
    const kb = new InlineKeyboard();
    await renderMenu(ctx, this.text(ctx, status), this.keyboard(ctx, status, kb, backCb));
  }

  private text(ctx: BotContext, s: GoogleStatus): string {
    if (!s.configured) return ctx.t('google-not-configured');
    if (!s.connected) return ctx.t('google-intro');
    const zone = ctx.actor?.account.timezone ?? 'UTC';
    const when = (d: Date | null): string => (d ? formatInZone(d, zone) : '—');
    return ctx.t('google-status', {
      email: escapeHtml(s.email ?? '—'),
      state: s.status === 'error' ? 'error' : 'ok',
      importState: ctx.t(s.importEnabled ? 'on' : 'off'),
      exportState: ctx.t(s.exportEnabled ? 'on' : 'off'),
      imported: when(s.lastImportAt),
      exported: when(s.lastExportAt),
      calendars: escapeHtml(s.busyCalendarIds.join(', ')),
    });
  }

  private keyboard(ctx: BotContext, s: GoogleStatus, kb: InlineKeyboard, backCb: string): InlineKeyboard {
    if (s.configured && !s.connected)
      kb.text(ctx.t('btn-google-connect'), sectionCb('settings', 'gcalurl')).row();
    if (s.connected) {
      if (s.status === 'error')
        kb.text(ctx.t('btn-google-reconnect'), sectionCb('settings', 'gcalurl')).row();
      const mark = (on: boolean): string => (on ? '☑️' : '⬜');
      kb.text(ctx.t('btn-google-import', { mark: mark(s.importEnabled) }), sectionCb('settings', 'gcalimp'))
        .text(ctx.t('btn-google-export', { mark: mark(s.exportEnabled) }), sectionCb('settings', 'gcalexp'))
        .row()
        .text(ctx.t('btn-google-sync'), sectionCb('settings', 'gcalsync'))
        .text(ctx.t('btn-google-disconnect'), sectionCb('settings', 'gcaloff'))
        .row();
    }
    return kb.text(ctx.t('btn-back'), backCb);
  }
}
