import type { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import type { BotKind } from '../libs/shared/src/config/env.schema.js';
import type { ActorResolver, ResolvedActor } from '../libs/modules/identity/actor-resolver.js';
import { createBot, type CreatedBot } from '../libs/telegram/src/core/bot-factory.js';
import type { BotContext } from '../libs/telegram/src/core/context.js';
import { createI18n } from '../libs/telegram/src/core/i18n.js';
import { createMemorySessionMiddleware } from '../libs/telegram/src/core/session.js';
import type { BotDefinition } from '../libs/telegram/src/gateway/bot-definition.js';
import { FAKE_BOT_INFO, FakeTelegram, type TgUser } from './telegram.js';

export interface BotHarness {
  bot: Bot<BotContext>;
  /** Processes a raw update with the error boundary applied. */
  handle(update: Update): Promise<void>;
  tg: FakeTelegram;
  /** Sends a text message from the user and waits until it is fully processed. */
  text(user: TgUser, text: string): Promise<void>;
  /** Presses the button with the given label on the last keyboard message sent to the user. */
  press(user: TgUser, label: RegExp | string): Promise<void>;
  /** Presses a raw callback payload on the last keyboard message. */
  callback(user: TgUser, data: string): Promise<void>;
}

export interface HarnessOptions {
  kind?: BotKind;
  registerChat?: (actor: ResolvedActor, chatId: number) => Promise<void>;
  isFreshUpdate?: (updateId: number) => Promise<boolean>;
}

/** Wires a bot definition to the fake Telegram API with in-memory sessions (no network, no Redis). */
export function createBotHarness(
  definition: BotDefinition,
  actors: ActorResolver,
  options: HarnessOptions = {},
): BotHarness {
  const kind = options.kind ?? definition.kind;
  const tg = new FakeTelegram();
  const created: CreatedBot = createBot({
    kind,
    token: '1:test',
    i18n: createI18n(),
    session: createMemorySessionMiddleware(kind),
    resolveActor: (id) => actors.byTelegramUserId(id, 'bot'),
    // same filter as the gateway: a bot may refuse to record chats of accounts without its role
    registerChat: options.registerChat
      ? async (actor, chatId) => {
          if (definition.registersChatFor && !definition.registersChatFor(actor.actor)) return;
          await options.registerChat!(actor, chatId);
        }
      : undefined,
    isFreshUpdate: options.isFreshUpdate,
    log: { error: () => undefined, warn: () => undefined },
    botInfo: { ...FAKE_BOT_INFO, username: `Test${kind}Bot` },
    throttle: false,
  });
  tg.install(created.bot);
  definition.setup(created);
  created.finalize();
  const bot = created.bot;

  const lastMessageId = (user: TgUser): number => {
    const last = tg.lastKeyboardMessage(user.id) ?? tg.lastMessage(user.id);
    const result = last?.result as { message_id?: number } | undefined;
    return Number(result?.message_id ?? last?.payload['message_id'] ?? 0);
  };

  return {
    bot,
    tg,
    handle: created.handle,
    text: (user, text) => created.handle(tg.textUpdate(user, text)),
    callback: (user, data) => created.handle(tg.callbackUpdate(user, data, lastMessageId(user))),
    press: async (user, label) => {
      const button = tg.findButton(label, user.id);
      if (!button?.callback_data) throw new Error(`button ${String(label)} not found on the last message`);
      await created.handle(tg.callbackUpdate(user, button.callback_data, lastMessageId(user)));
    },
  };
}
