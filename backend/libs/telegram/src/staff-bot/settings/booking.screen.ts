import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import type { Actor } from '@modules/access/actor.js';
import { GRID_STEPS } from '@modules/people/teacher-settings.rules.js';
import { TeacherSettingsUseCase } from '@modules/people/teacher-settings.use-case.js';
import { DEFAULT_BOOKING_RULES } from '@modules/schedule/availability/open-slots.query.js';
import type { BotContext } from '../../core/context.js';
import { renderMenu } from '../../core/ui.js';
import { sectionCb } from '../section-module.js';

/**
 * StaffBot → Настройки → Запись (5.5.5): confirmation mode, minimum notice, horizon, durations, grid step and
 * the pending-per-slot limit. The calendar mode itself is switched on the «Окна и календарь» screen.
 */
@Injectable()
export class BookingSettingsScreen {
  constructor(private readonly settings: TeacherSettingsUseCase) {}

  async render(ctx: BotContext, actor: Actor): Promise<void> {
    const { profile } = await this.settings.get(actor);
    const rules = { ...DEFAULT_BOOKING_RULES, ...profile.bookingRules };
    const kb = new InlineKeyboard()
      .text(ctx.t(`btn-booking-confirmation-${profile.bookingConfirmation}`), sectionCb('settings', 'bconf'))
      .text(ctx.t('btn-booking-step', { step: rules.gridStepMin }), sectionCb('settings', 'bstep'))
      .row()
      .text(ctx.t('btn-booking-notice'), sectionCb('settings', 'edit', 'bookingMinNoticeHours'))
      .text(ctx.t('btn-booking-horizon'), sectionCb('settings', 'edit', 'bookingHorizonDays'))
      .row()
      .text(ctx.t('btn-booking-durations'), sectionCb('settings', 'edit', 'bookingDurations'))
      .text(ctx.t('btn-booking-pending'), sectionCb('settings', 'edit', 'bookingMaxPending'))
      .row()
      .text(ctx.t('btn-back'), sectionCb('settings', 'main'));
    await renderMenu(
      ctx,
      ctx.t('booking-settings', {
        mode: ctx.t(`calendar-mode-${profile.calendarMode.replace(/_/g, '-')}`),
        confirmation: profile.bookingConfirmation,
        notice: rules.minNoticeHours,
        horizon: rules.horizonDays,
        durations:
          rules.durations.length > 0
            ? rules.durations.join(', ')
            : ctx.t('booking-durations-default', { duration: profile.defaultDurationMin }),
        step: rules.gridStepMin,
        pending: rules.maxPendingPerSlot,
      }),
      kb,
    );
  }

  async toggleConfirmation(actor: Actor): Promise<void> {
    const { profile } = await this.settings.get(actor);
    await this.settings.update(actor, {
      bookingConfirmation: profile.bookingConfirmation === 'auto' ? 'manual' : 'auto',
    });
  }

  /** 15 → 30 → 60 → 15. */
  async cycleStep(actor: Actor): Promise<void> {
    const { profile } = await this.settings.get(actor);
    const current = profile.bookingRules.gridStepMin ?? DEFAULT_BOOKING_RULES.gridStepMin;
    const next = GRID_STEPS[(GRID_STEPS.indexOf(current) + 1) % GRID_STEPS.length]!;
    await this.settings.update(actor, { bookingRules: { gridStepMin: next } });
  }
}
