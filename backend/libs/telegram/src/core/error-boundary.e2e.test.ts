import { describe, expect, it } from 'vitest';
import { AppError } from '@shared/errors/app-error.js';
import { createBotHarness } from '@test/bot.js';

describe('error boundary', () => {
  it('maps AppError to an i18n reply', async () => {
    const h = createBotHarness(
      {
        kind: 'auth',
        commands: [],
        setup({ bot }) {
          bot.command('boom', () => {
            throw new AppError('CONFLICT', 'x');
          });
        },
      },
      { byTelegramUserId: async () => null, byAccountId: async () => null } as never,
    );
    await h.text({ id: 1, first_name: 'a' }, '/boom');
    expect(h.tg.sentTexts(1).at(-1)).toContain('уже выполнено');
  });
});
