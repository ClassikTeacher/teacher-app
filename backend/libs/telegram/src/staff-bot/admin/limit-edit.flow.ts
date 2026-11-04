import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import type { FeatureKey } from '@modules/access/features/catalog.js';
import { FeatureAdminUseCase } from '@modules/access/features/feature-admin.use-case.js';
import type { BotContext } from '../../core/context.js';
import { Flow, flowCb, type FlowStep } from '../../core/flow.js';
import { renderMenu, say } from '../../core/ui.js';
import { sectionCb } from '../section-module.js';

export interface LimitEditData extends Record<string, unknown> {
  teacherId: string;
  key: FeatureKey;
  limitName: string;
  value: number | null;
}

const MB = 1024 * 1024;

/** Enter a personal limit value for a teacher: a number (MB for byte limits) or "no limit". */
@Injectable()
export class LimitEditFlow extends Flow<LimitEditData> {
  readonly name = 'limit-edit';
  readonly firstStep = 'value';

  constructor(private readonly admin: FeatureAdminUseCase) {
    super();
  }

  async initial(_ctx: BotContext, arg: unknown): Promise<LimitEditData> {
    const start = arg as { teacherId: string; key: FeatureKey; limitName: string };
    return { teacherId: start.teacherId, key: start.key, limitName: start.limitName, value: null };
  }

  readonly steps: Record<string, FlowStep<LimitEditData>> = {
    value: {
      enter: async (ctx, d) => {
        const kb = new InlineKeyboard()
          .text(ctx.t('limit-none'), flowCb('value', 'none'))
          .text(ctx.t('btn-cancel'), flowCb('value', 'cancel'));
        const unit = d.limitName.endsWith('Bytes') ? ctx.t('unit-mb') : '';
        await renderMenu(ctx, ctx.t('limit-enter', { limit: ctx.t(`limit-${d.limitName}`), unit }), kb);
      },
      onCallback: async (ctx, d, action) => {
        if (action === 'none') {
          d.value = null;
          return { done: true };
        }
        if (action === 'cancel') {
          ctx.session.flow = undefined;
          await say(ctx, ctx.t('cancel-done'));
        }
        return { stay: true };
      },
      onText: async (ctx, d, text) => {
        if (!/^\d{1,9}$/.test(text)) {
          await say(ctx, ctx.t('limit-invalid'));
          return { stay: true };
        }
        const raw = Number(text);
        d.value = d.limitName.endsWith('Bytes') ? raw * MB : raw;
        return { done: true };
      },
    },
  };

  async complete(ctx: BotContext, d: LimitEditData): Promise<void> {
    if (!ctx.actor) return;
    // Only the edited key is sent: other limits keep following the platform defaults (H2 of the M1-06 review).
    await this.admin.setTeacher(ctx.actor.actor, d.teacherId, d.key, { limits: { [d.limitName]: d.value } });
    const back = sectionCb('features', 'teacher', d.teacherId);
    await renderMenu(ctx, ctx.t('limit-saved'), new InlineKeyboard().text(ctx.t('btn-back'), back));
  }
}
