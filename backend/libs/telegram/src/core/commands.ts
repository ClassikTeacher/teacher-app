import type { Bot } from 'grammy';
import type { BotContext } from './context.js';

export interface BotCommandSpec {
  command: string;
  description: string;
}

/**
 * Sets the command list for one private chat (4.4 "Команды по ролям": `setMyCommands` with a chat scope).
 * Failures are swallowed: the menu still works via buttons.
 */
export async function syncChatCommands(
  bot: Pick<Bot<BotContext>, 'api'>,
  chatId: number,
  commands: readonly BotCommandSpec[],
): Promise<void> {
  await bot.api
    .setMyCommands([...commands], { scope: { type: 'chat', chat_id: chatId } })
    .catch(() => undefined);
}
