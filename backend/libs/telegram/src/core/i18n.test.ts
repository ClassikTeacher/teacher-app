import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@shared/errors/app-error.js';
import { createI18n } from './i18n.js';

describe('ru locale', () => {
  const i18n = createI18n();

  it('has a message for every domain error code', () => {
    for (const code of ERROR_CODES) {
      const key = `error-${code.toLowerCase().replace(/_/g, '-')}`;
      expect(i18n.t('ru', key), key).not.toBe(key);
    }
  });

  it('renders variables without Unicode isolation marks', () => {
    expect(i18n.t('ru', 'invite-add-role', { role: 'учитель' })).toBe(
      'Вам предлагают роль «учитель». Добавить её к вашему аккаунту?',
    );
  });
});
