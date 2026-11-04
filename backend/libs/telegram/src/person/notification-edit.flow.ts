import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import { NotificationSettingsUseCase } from '@modules/notifications/notification-settings.use-case.js';
import type { BotContext } from '../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../core/flow.js';
import { renderMenu, say } from '../core/ui.js';

export interface NotificationEditData extends Record<string, unknown> {
  field: 'quiet' | 'digestTime';
  /** Callback of the «back» button: the notifications screen of the bot. */
  backCb: string;
}

const TIME = /^(\d{1,2}):(\d{2})$/;

/** One typed value: the quiet-hours range «22:00-08:00» (NTF-06) or the digest time «08:00» (5.5.7). */
@Injectable()
export class NotificationEditFlow extends Flow<NotificationEditData> {
  readonly name = 'notification-edit';
  readonly firstStep = 'value';

  constructor(private readonly settings: NotificationSettingsUseCase) {
    super();
  }

  async initial(_ctx: BotContext, arg: unknown): Promise<NotificationEditData> {
    return arg as NotificationEditData;
  }

  private async leave(ctx: BotContext, d: NotificationEditData, text: string): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(ctx, text, new InlineKeyboard().text(ctx.t('btn-back'), d.backCb));
    return { stay: true };
  }

  readonly steps: Record<string, FlowStep<NotificationEditData>> = {
    value: {
      enter: async (ctx, d) => {
        const key = d.field === 'quiet' ? 'notif-quiet-prompt' : 'notif-digest-time-prompt';
        await renderMenu(
          ctx,
          ctx.t(key),
          new InlineKeyboard().text(ctx.t('btn-cancel'), flowCb('value', 'cancel')),
        );
      },
      onCallback: async (ctx, d, action) =>
        action === 'cancel' ? this.leave(ctx, d, ctx.t('cancel-done')) : { stay: true },
      onText: async (ctx, d, text) => {
        const actor = ctx.actor!.actor;
        try {
          if (d.field === 'quiet') {
            const parts = text.replace(/[–—]/g, '-').split(/\s*-\s*/);
            if (parts.length !== 2 || !TIME.test(parts[0]!) || !TIME.test(parts[1]!)) {
              await say(ctx, ctx.t('notif-quiet-invalid'));
              return { stay: true };
            }
            await this.settings.setQuietHours(actor, parts[0]!, parts[1]!);
          } else {
            if (!TIME.test(text.trim())) {
              await say(ctx, ctx.t('notif-time-invalid'));
              return { stay: true };
            }
            await this.settings.setDigestTime(actor, text.trim());
          }
        } catch (error) {
          if (!AppError.is(error, 'VALIDATION_ERROR')) throw error;
          await say(ctx, ctx.t(d.field === 'quiet' ? 'notif-quiet-invalid' : 'notif-time-invalid'));
          return { stay: true };
        }
        return this.leave(ctx, d, ctx.t('setting-saved'));
      },
    },
  };

  async complete(): Promise<void> {}
}
