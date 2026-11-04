import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { DateTime } from 'luxon';
import { AppError } from '@shared/errors/app-error.js';
import type { Actor } from '@modules/access/actor.js';
import { CALENDAR_MODES, type TeacherProfileRow } from '@modules/people/schema.js';
import { TeacherSettingsUseCase } from '@modules/people/teacher-settings.use-case.js';
import { AvailabilityUseCase } from '@modules/schedule/availability/availability.use-case.js';
import { timeToMinutes } from '@modules/schedule/availability/windows.js';
import type { AvailabilityExceptionRow, AvailabilityRuleRow } from '@modules/schedule/schema.js';
import type { BotContext } from '../../core/context.js';
import { escapeHtml, renderMenu } from '../../core/ui.js';
import { zoneOf } from '../schedule/day-picker.js';
import { minutesLabel } from '../schedule/time-input.js';
import { sectionCb } from '../section-module.js';

export const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** «Настройки → Окна и календарь» (5.5.4, 5.5.5): weekly rules, upcoming exceptions, the calendar mode. */
@Injectable()
export class WindowsScreen {
  constructor(
    private readonly availability: AvailabilityUseCase,
    private readonly settings: TeacherSettingsUseCase,
  ) {}

  async render(ctx: BotContext, actor: Actor): Promise<void> {
    const zone = zoneOf(ctx);
    const [rules, exceptions, { profile }] = await Promise.all([
      this.availability.listRules(actor),
      this.availability.listUpcomingExceptions(actor, zone),
      this.settings.get(actor),
    ]);
    const kb = new InlineKeyboard();
    rules.forEach((r, i) => {
      kb.text(`🗑 ${this.ruleLabel(ctx, r)}`, sectionCb('settings', 'wrdel', r.id));
      if (i % 2 === 1) kb.row();
    });
    if (rules.length % 2 === 1) kb.row();
    exceptions.forEach((e) =>
      kb.text(`🗑 ${this.exceptionLabel(ctx, e, zone)}`, sectionCb('settings', 'wedel', e.id)).row(),
    );
    kb.text(ctx.t('btn-add-rule'), sectionCb('settings', 'wradd'))
      .text(ctx.t('btn-close-day'), sectionCb('settings', 'weadd', 'closed'))
      .row()
      .text(ctx.t('btn-extra-window'), sectionCb('settings', 'weadd', 'extra'))
      .text(
        ctx.t(`btn-calendar-mode-${profile.calendarMode.replace(/_/g, '-')}`),
        sectionCb('settings', 'wmode'),
      )
      .row()
      .text(ctx.t('btn-back'), sectionCb('settings', 'main'));
    const ruleLines = rules.map((r) => `• ${this.ruleLabel(ctx, r)}${this.validity(ctx, r)}`).join('\n');
    const exceptionLines = exceptions.map((e) => `• ${this.exceptionLabel(ctx, e, zone)}`).join('\n');
    await renderMenu(
      ctx,
      ctx.t('windows-screen', {
        rules: ruleLines || ctx.t('windows-none'),
        exceptions: exceptionLines || ctx.t('windows-no-exceptions'),
        mode: ctx.t(`calendar-mode-${profile.calendarMode.replace(/_/g, '-')}`),
      }),
      kb,
    );
  }

  /** closed → open_all → open_selected → closed (5.5.5 "Режим"). */
  async toggleMode(actor: Actor): Promise<TeacherProfileRow> {
    const { profile } = await this.settings.get(actor);
    const next = CALENDAR_MODES[(CALENDAR_MODES.indexOf(profile.calendarMode) + 1) % CALENDAR_MODES.length]!;
    return (await this.settings.update(actor, { calendarMode: next })).profile;
  }

  /** Removal is idempotent for the screen: a vanished row only produces a short notice. */
  async remove(ctx: BotContext, actor: Actor, kind: 'rule' | 'exception', id: string): Promise<void> {
    try {
      if (kind === 'rule') await this.availability.removeRule(actor, id);
      else await this.availability.removeException(actor, id);
    } catch (error) {
      if (!AppError.is(error, 'CONFLICT') && !AppError.is(error, 'NOT_FOUND')) throw error;
      await ctx.answerCallbackQuery({ text: ctx.t('callback-stale') }).catch(() => undefined);
    }
  }

  ruleLabel(ctx: BotContext, r: AvailabilityRuleRow): string {
    return `${ctx.t(`weekday-${WEEKDAY_KEYS[r.weekday - 1]}`)} ${minutesLabel(timeToMinutes(r.startLocal))}–${minutesLabel(timeToMinutes(r.endLocal))}`;
  }

  private validity(ctx: BotContext, r: AvailabilityRuleRow): string {
    if (!r.validFrom && !r.validTo) return '';
    const fmt = (iso: string | null): string =>
      iso ? DateTime.fromISO(iso).toFormat('dd.MM') : ctx.t('validity-open-ended');
    return ` (${fmt(r.validFrom)}–${fmt(r.validTo)})`;
  }

  exceptionLabel(ctx: BotContext, e: AvailabilityExceptionRow, zone: string): string {
    const day = DateTime.fromISO(e.date, { zone })
      .setLocale(ctx.actor?.account.locale ?? 'ru')
      .toFormat('ccc dd.MM');
    const span =
      e.startLocal && e.endLocal
        ? ` ${minutesLabel(timeToMinutes(e.startLocal))}–${minutesLabel(timeToMinutes(e.endLocal))}`
        : '';
    return escapeHtml(`${e.kind === 'closed' ? '🚫' : '➕'} ${day}${span}`);
  }
}
