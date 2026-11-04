import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { isValidTimezone } from '@shared/time/timezone.js';
import {
  MAX_LESSON_DURATION_MIN,
  MIN_LESSON_DURATION_MIN,
} from '@modules/people/teacher-profile.defaults.js';
import {
  MAX_BUFFER_MIN,
  MAX_CANCEL_HOURS,
  MAX_NOTICE_TEXT_LENGTH,
  MAX_TEMPLATE_TEXT_LENGTH,
  type TeacherSettingsPatch,
} from '@modules/people/teacher-settings.rules.js';
import {
  MAX_HORIZON_DAYS,
  MAX_MIN_NOTICE_HOURS,
  MAX_PENDING_PER_SLOT,
} from '@modules/people/teacher-settings.rules.js';
import { TeacherSettingsUseCase } from '@modules/people/teacher-settings.use-case.js';
import type { BotContext } from '../../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../../core/flow.js';
import { MAX_PERSON_NAME_LENGTH } from '@modules/people/person-onboarding.service.js';
import { renderMenu, say } from '../../core/ui.js';
import { isTerminalFlowError } from '../common/flow-errors.js';
import { sectionCb } from '../section-module.js';

/** Settings edited by typing one value (numbers, texts, timezone); toggles live in the section itself. */
export const SETTING_FIELDS = [
  'name',
  'timezone',
  'defaultDurationMin',
  'bufferBeforeMin',
  'bufferAfterMin',
  'lateCancelHours',
  'studentCancelCutoffHours',
  'defaultNoticeText',
  'template',
  'bookingMinNoticeHours',
  'bookingHorizonDays',
  'bookingDurations',
  'bookingMaxPending',
] as const;
export type SettingField = (typeof SETTING_FIELDS)[number];

export function isSettingField(value: string): value is SettingField {
  return (SETTING_FIELDS as readonly string[]).includes(value);
}

export interface SettingEditData extends Record<string, unknown> {
  field: SettingField;
}

const INTEGER_RANGES: Partial<Record<SettingField, [number, number]>> = {
  defaultDurationMin: [MIN_LESSON_DURATION_MIN, MAX_LESSON_DURATION_MIN],
  bufferBeforeMin: [0, MAX_BUFFER_MIN],
  bufferAfterMin: [0, MAX_BUFFER_MIN],
  lateCancelHours: [0, MAX_CANCEL_HOURS],
  studentCancelCutoffHours: [0, MAX_CANCEL_HOURS],
  bookingMinNoticeHours: [0, MAX_MIN_NOTICE_HOURS],
  bookingHorizonDays: [1, MAX_HORIZON_DAYS],
  bookingMaxPending: [1, MAX_PENDING_PER_SLOT],
};
/** Settings that live inside `bookingRules` (5.5.5) rather than as profile columns. */
const BOOKING_RULE_KEYS: Partial<
  Record<SettingField, 'minNoticeHours' | 'horizonDays' | 'maxPendingPerSlot'>
> = {
  bookingMinNoticeHours: 'minNoticeHours',
  bookingHorizonDays: 'horizonDays',
  bookingMaxPending: 'maxPendingPerSlot',
};

/** One prompt → one typed value → PATCH of the profile → back to «Настройки». */
@Injectable()
export class SettingEditFlow extends Flow<SettingEditData> {
  readonly name = 'setting-edit';
  readonly firstStep = 'value';

  constructor(private readonly settings: TeacherSettingsUseCase) {
    super();
  }

  async initial(_ctx: BotContext, arg: unknown): Promise<SettingEditData> {
    return arg as SettingEditData;
  }

  readonly steps: Record<string, FlowStep<SettingEditData>> = {
    value: {
      enter: async (ctx, d) => {
        const kb = new InlineKeyboard();
        if (d.field === 'studentCancelCutoffHours') kb.text(ctx.t('btn-no-cutoff'), flowCb('value', 'none'));
        kb.text(ctx.t('btn-cancel'), flowCb('value', 'cancel'));
        await renderMenu(ctx, ctx.t(`setting-edit-${d.field}`), kb);
      },
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') {
          ctx.session.flow = undefined;
          await renderMenu(ctx, ctx.t('cancel-done'), this.back(ctx));
          return { stay: true };
        }
        if (action === 'none' && d.field === 'studentCancelCutoffHours') {
          return this.save(ctx, { studentCancelCutoffHours: null });
        }
        return { stay: true };
      },
      onText: async (ctx, d, text) => this.onText(ctx, d, text),
    },
  };

  private async onText(ctx: BotContext, d: SettingEditData, text: string): Promise<FlowNext> {
    const range = INTEGER_RANGES[d.field];
    if (range) {
      const n = /^\d{1,4}$/.test(text) ? Number(text) : NaN;
      if (!Number.isInteger(n) || n < range[0] || n > range[1]) {
        await say(ctx, ctx.t('setting-integer-invalid', { min: range[0], max: range[1] }));
        return { stay: true };
      }
      const rule = BOOKING_RULE_KEYS[d.field];
      return rule
        ? this.save(ctx, { bookingRules: { [rule]: n } }, 'booking')
        : this.save(ctx, { [d.field]: n });
    }
    switch (d.field) {
      case 'bookingDurations': {
        const parts = text.split(/[\s,;]+/).filter(Boolean);
        const durations = parts.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
        if (durations.some((x) => !Number.isInteger(x))) {
          await say(
            ctx,
            ctx.t('setting-integer-invalid', { min: MIN_LESSON_DURATION_MIN, max: MAX_LESSON_DURATION_MIN }),
          );
          return { stay: true };
        }
        return this.save(ctx, { bookingRules: { durations } }, 'booking');
      }
      case 'name': {
        const [first, ...rest] = text.split(/\s+/).filter(Boolean);
        if (!first || text.length > MAX_PERSON_NAME_LENGTH) {
          await say(ctx, ctx.t('onb-name-invalid'));
          return { stay: true };
        }
        return this.save(ctx, { firstName: first, lastName: rest.join(' ') });
      }
      case 'timezone':
        if (!isValidTimezone(text)) {
          await say(ctx, ctx.t('onb-timezone-invalid'));
          return { stay: true };
        }
        return this.save(ctx, { timezone: text });
      case 'defaultNoticeText':
        if (text.length > MAX_NOTICE_TEXT_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_NOTICE_TEXT_LENGTH }));
          return { stay: true };
        }
        return this.save(ctx, { defaultNoticeText: text });
      case 'template':
        if (text.length > MAX_TEMPLATE_TEXT_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_TEMPLATE_TEXT_LENGTH }));
          return { stay: true };
        }
        try {
          if (ctx.actor) await this.settings.addTemplate(ctx.actor.actor, 'cancel_reason', text);
        } catch (error) {
          if (isTerminalFlowError(error)) ctx.session.flow = undefined; // e.g. 20 templates already
          throw error;
        }
        ctx.session.flow = undefined;
        await renderMenu(ctx, ctx.t('setting-saved'), this.back(ctx, 'templates'));
        return { stay: true };
      default:
        return { stay: true };
    }
  }

  private async save(ctx: BotContext, patch: TeacherSettingsPatch, screen = 'main'): Promise<FlowNext> {
    if (!ctx.actor) return { stay: true };
    try {
      await this.settings.update(ctx.actor.actor, patch);
    } catch (error) {
      if (isTerminalFlowError(error)) ctx.session.flow = undefined;
      throw error;
    }
    ctx.session.flow = undefined;
    await renderMenu(ctx, ctx.t('setting-saved'), this.back(ctx, screen));
    return { stay: true };
  }

  private back(ctx: BotContext, screen = 'main'): InlineKeyboard {
    return new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('settings', screen));
  }

  async complete(): Promise<void> {}
}
