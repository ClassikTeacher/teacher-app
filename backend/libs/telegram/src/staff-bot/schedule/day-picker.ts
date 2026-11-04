import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../../core/context.js';
import { DAY_ISO, fmtDay, localDay } from './time-input.js';

/** Days offered as buttons in day pickers: today, tomorrow and the next five days (5.6.3 step 2). */
export const PICKER_DAYS = 7;

/** Rows "Сегодня / Завтра" + weekday buttons; `payload(dateIso)` builds each button's callback. */
export function dayPickerKeyboard(
  ctx: BotContext,
  zone: string,
  now: Date,
  payload: (dateIso: string) => string,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const today = localDay(zone, now);
  kb.text(ctx.t('btn-day-today'), payload(today.toFormat(DAY_ISO)))
    .text(ctx.t('btn-day-tomorrow'), payload(today.plus({ days: 1 }).toFormat(DAY_ISO)))
    .row();
  for (let i = 2; i < PICKER_DAYS; i += 1) {
    const iso = today.plus({ days: i }).toFormat(DAY_ISO);
    kb.text(fmtDay(iso, zone), payload(iso));
    if ((i - 2) % 3 === 2) kb.row();
  }
  if ((PICKER_DAYS - 2) % 3 !== 0) kb.row();
  return kb;
}

/** The zone the acting person sees times in (CAL-05). */
export function zoneOf(ctx: BotContext): string {
  return ctx.actor?.account.timezone ?? 'UTC';
}
