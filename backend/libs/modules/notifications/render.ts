import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { I18n } from '@grammyjs/i18n';
import type { Context } from 'grammy';
import type { NotificationRow } from './schema.js';

/** Fluent resources shared with the bots (libs/telegram/src/i18n). */
function localesDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'telegram', 'src', 'i18n');
}

/** Renders a notification to Telegram HTML: `ntf-<type>` with payload variables (already escaped by producers). */
export class NotificationRenderer {
  private readonly i18n: I18n<Context>;

  constructor() {
    this.i18n = new I18n<Context>({ defaultLocale: 'ru', fluentBundleOptions: { useIsolating: false } });
    this.i18n.loadLocalesDirSync(localesDir());
  }

  /** Plain lookup for labels (buttons) that producers attach to payloads. */
  t(key: string, locale = 'ru', vars?: Record<string, string | number>): string {
    return this.i18n.t(locale, key, vars);
  }

  render(notification: Pick<NotificationRow, 'typeCode' | 'payload'>, locale = 'ru'): string | null {
    const key = `ntf-${notification.typeCode.replace(/[._]/g, '-')}`;
    const vars = Object.fromEntries(
      Object.entries(notification.payload).filter(([, v]) => typeof v === 'string' || typeof v === 'number'),
    ) as Record<string, string | number>;
    try {
      const text = this.i18n.t(locale, key, vars);
      // @grammyjs/i18n returns the key (possibly wrapped in braces) when the message is missing or invalid.
      return text === key || text === `{${key}}` ? null : text;
    } catch {
      return null; // e.g. a variable the producer forgot: the sender records "no template" instead of crashing
    }
  }
}
