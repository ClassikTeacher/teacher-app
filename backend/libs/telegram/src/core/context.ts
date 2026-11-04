import type { I18nFlavor } from '@grammyjs/i18n';
import type { Context, SessionFlavor } from 'grammy';
import type { BotKind } from '@shared/config/env.schema.js';
import type { ResolvedActor } from '@modules/identity/actor-resolver.js';

/** Multi-step dialog state kept in the Redis session (T-07). */
export interface FlowState {
  name: string;
  step: string;
  data: Record<string, unknown>;
  startedAt: number;
}

export interface SessionData {
  flow?: FlowState;
  /** The single editable menu message (4.4 "Одно сообщение-меню"). */
  menuMessageId?: number;
  lastActiveAt?: number;
  /** Account whose bot_chat row was upserted for this chat (avoids a write per update). */
  chatRegisteredFor?: string;
  /** Role set for which chat-scoped commands were last synced. */
  commandsSyncedFor?: string;
  /** Screen context that does not fit into 64-byte callback payloads (e.g. the selected teacher). */
  scratch?: Record<string, unknown>;
}

export interface BotFlavor {
  /** Which of the four bots received the update. */
  bot: BotKind;
  /** Resolved platform account of the Telegram user, or null for strangers. */
  actor: ResolvedActor | null;
}

export type BotContext = Context & SessionFlavor<SessionData> & I18nFlavor & BotFlavor;
