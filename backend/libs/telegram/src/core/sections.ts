import type { Actor } from '@modules/access/actor.js';
import type { CreatedBot } from './bot-factory.js';
import { cb } from './callback.js';
import type { BotContext } from './context.js';

export const SECTION_NS = 's';

/**
 * A bot screen reachable from the menu. `open` renders the entry screen; button presses with payload
 * `s:<section>:<action>[:args]` reach `onCallback` after the bot's central authorization check.
 * `register` lets the section add its flows to the bot. Shared by StaffBot, StudentBot and ParentBot.
 */
export interface SectionModule<K extends string> {
  readonly section: K;
  register?(created: CreatedBot): void;
  open(ctx: BotContext, actor: Actor): Promise<void>;
  onCallback?(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void>;
}

/** Button payload inside a section. */
export const sectionCb = (section: string, action: string, ...args: Array<string | number>): string =>
  cb(SECTION_NS, section, action, ...args);
