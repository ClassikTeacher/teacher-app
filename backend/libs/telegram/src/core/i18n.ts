import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { I18n } from '@grammyjs/i18n';
import type { BotContext } from './context.js';

export const DEFAULT_LOCALE = 'ru';

/** Fluent resources live next to the code so the runtime image copies them (see Dockerfile). */
export function localesDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'i18n');
}

export function createI18n(): I18n<BotContext> {
  const i18n = new I18n<BotContext>({
    defaultLocale: DEFAULT_LOCALE,
    useSession: false,
    // No Unicode isolation marks around variables: they show up as stray characters in Telegram clients.
    fluentBundleOptions: { useIsolating: false },
    localeNegotiator: (ctx) => ctx.actor?.account.locale ?? DEFAULT_LOCALE,
  });
  i18n.loadLocalesDirSync(localesDir());
  return i18n;
}
