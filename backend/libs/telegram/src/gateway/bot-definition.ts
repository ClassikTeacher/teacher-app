import type { BotKind } from '@shared/config/env.schema.js';
import type { Actor } from '@modules/access/actor.js';
import type { CreatedBot } from '../core/bot-factory.js';

/** One of the four bots: registers its commands, menus and flows on the shared wiring. */
export interface BotDefinition {
  readonly kind: BotKind;
  /** Commands shown in the Telegram menu by default (scoped lists are set per chat later). */
  readonly commands: ReadonlyArray<{ command: string; description: string }>;
  setup(created: CreatedBot): void;
  /** Whether this account's private chat should be recorded as a delivery channel of this bot (default: yes). */
  registersChatFor?(actor: Actor): boolean;
}

export const BOT_DEFINITIONS = Symbol('BOT_DEFINITIONS');
