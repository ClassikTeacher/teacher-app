import type { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
  result?: unknown;
}

export interface Button {
  text: string;
  callback_data?: string;
  url?: string;
}

export const FAKE_BOT_INFO: UserFromGetMe = {
  id: 1_000_000,
  is_bot: true,
  first_name: 'Test Bot',
  username: 'TestAuthBot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

const isMessageCall = (c: ApiCall, chatId?: number): boolean =>
  (c.method === 'sendMessage' || c.method === 'editMessageText') &&
  (chatId === undefined || c.payload['chat_id'] === chatId);

/**
 * Replaces the Telegram Bot API with an in-memory recorder (10.6 "e2e ботов с подменой Telegram API").
 * Every outgoing call is captured; replies get increasing message ids so menu editing can be asserted.
 */
export class FakeTelegram {
  readonly calls: ApiCall[] = [];
  private nextMessageId = 100;
  private nextUpdateId = 1;
  /** Methods that should fail with a Telegram error (e.g. simulate 403 blocked by user). */
  failures = new Map<string, { error_code: number; description: string }>();

  install(bot: Bot<never> | Bot<any>): void {
    bot.api.config.use(async (_prev, method, payload) => {
      const call: ApiCall = { method, payload: payload };
      this.calls.push(call);
      const failure = this.failures.get(method);
      if (failure) {
        return { ok: false, error_code: failure.error_code, description: failure.description } as never;
      }
      call.result = this.resultFor(method, call.payload);
      return { ok: true, result: call.result } as never;
    });
  }

  private resultFor(method: string, payload: Record<string, unknown>): unknown {
    switch (method) {
      case 'sendMessage':
      case 'editMessageText':
      case 'sendPhoto':
        return {
          message_id: method === 'editMessageText' ? payload['message_id'] : this.nextMessageId++,
          date: Math.floor(Date.now() / 1000),
          chat: { id: payload['chat_id'], type: 'private' },
          text: payload['text'],
        };
      case 'sendDocument':
        return this.documentMessage(payload, payload['document']);
      case 'sendMediaGroup':
        return ((payload['media'] as Array<{ media: unknown }>) ?? []).map((m) =>
          this.documentMessage(payload, m.media),
        );
      case 'getFile':
        return {
          file_id: payload['file_id'],
          file_unique_id: `u-${String(payload['file_id'])}`,
          file_path: 'documents/x',
        };
      case 'getMe':
        return FAKE_BOT_INFO;
      default:
        return true;
    }
  }

  /** A document message: a re-sent `file_id` string keeps its id, an upload gets a fresh one (cache tests). */
  private documentMessage(payload: Record<string, unknown>, media: unknown) {
    const fileId = typeof media === 'string' ? media : `doc-${this.nextMessageId}`;
    return {
      message_id: this.nextMessageId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: payload['chat_id'], type: 'private' },
      document: { file_id: fileId, file_unique_id: `u-${fileId}`, file_name: 'file' },
    };
  }

  /** Documents sent to a chat (sendDocument and album items), in order. */
  sentDocuments(chatId?: number): unknown[] {
    return this.calls
      .filter(
        (c) =>
          (c.method === 'sendDocument' || c.method === 'sendMediaGroup') &&
          (chatId === undefined || c.payload['chat_id'] === chatId),
      )
      .flatMap((c) =>
        c.method === 'sendDocument'
          ? [c.payload['document']]
          : (c.payload['media'] as Array<{ media: unknown }>).map((m) => m.media),
      );
  }

  /** Texts of messages sent or edited in a chat, in order. */
  sentTexts(chatId?: number): string[] {
    return this.calls.filter((c) => isMessageCall(c, chatId)).map((c) => String(c.payload['text']));
  }

  lastMessage(chatId?: number): ApiCall | undefined {
    return [...this.calls].reverse().find((c) => isMessageCall(c, chatId));
  }

  /** The most recent message that carries an inline keyboard (plain notices do not replace the menu). */
  lastKeyboardMessage(chatId?: number): ApiCall | undefined {
    return [...this.calls].reverse().find((c) => {
      if (!isMessageCall(c, chatId)) return false;
      const markup = c.payload['reply_markup'] as { inline_keyboard?: unknown[][] } | undefined;
      return (markup?.inline_keyboard?.length ?? 0) > 0;
    });
  }

  lastKeyboard(chatId?: number): Button[][] {
    const markup = this.lastKeyboardMessage(chatId)?.payload['reply_markup'] as
      { inline_keyboard?: Button[][] } | undefined;
    return markup?.inline_keyboard ?? [];
  }

  findButton(label: RegExp | string, chatId?: number): Button | undefined {
    return this.lastKeyboard(chatId)
      .flat()
      .find((b) => (label instanceof RegExp ? label.test(b.text) : b.text === label));
  }

  reset(): void {
    this.calls.length = 0;
  }

  textUpdate(user: TgUser, text: string): Update {
    const command = text.startsWith('/') ? text.split(' ')[0]!.length : 0;
    const message = {
      message_id: this.nextMessageId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: user.id, type: 'private' as const, first_name: user.first_name },
      from: { ...user, is_bot: false },
      text,
      ...(command > 0 ? { entities: [{ type: 'bot_command' as const, offset: 0, length: command }] } : {}),
    };
    return { update_id: this.nextUpdateId++, message };
  }

  callbackUpdate(user: TgUser, data: string, messageId: number): Update {
    return {
      update_id: this.nextUpdateId++,
      callback_query: {
        id: String(this.nextUpdateId),
        from: { ...user, is_bot: false },
        chat_instance: 'ci',
        data,
        message: {
          message_id: messageId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: user.id, type: 'private' as const, first_name: user.first_name },
          text: 'menu',
        },
      },
    };
  }
}

export interface TgUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}
