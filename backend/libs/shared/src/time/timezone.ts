import { DateTime, IANAZone } from 'luxon';

export function isValidTimezone(zone: string): boolean {
  return IANAZone.isValidZone(zone);
}

/** Formats an instant in the recipient's timezone, e.g. "21.10 16:00". */
export function formatInZone(date: Date, zone: string, format = 'dd.MM HH:mm', locale = 'ru'): string {
  return DateTime.fromJSDate(date, { zone }).setLocale(locale).toFormat(format);
}

/** Timezones offered as buttons in onboarding; any valid IANA zone is accepted as text. */
export const COMMON_TIMEZONES: readonly string[] = [
  'Europe/Minsk',
  'Europe/Moscow',
  'Europe/Kaliningrad',
  'Europe/Kyiv',
  'Europe/Warsaw',
  'Europe/Vilnius',
  'Asia/Almaty',
  'Asia/Tashkent',
  'Asia/Yekaterinburg',
  'Asia/Novosibirsk',
  'Asia/Tbilisi',
  'Asia/Yerevan',
];
