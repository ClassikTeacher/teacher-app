import { InlineKeyboard } from 'grammy';
import { botConfigs, type Env } from '@shared/config/index.js';
import type { InvitationKind } from '@modules/identity/schema.js';
import { INVITATION_BOT } from '@modules/identity/invitation.rules.js';
import type { BotKind } from '@shared/config/env.schema.js';
import type { BotContext } from '../core/context.js';
import { say } from '../core/ui.js';

/**
 * A deep link opened in the wrong bot (a parent link in StudentBot, a staff link anywhere else):
 * explain and offer a button to the right bot. Returns false when the kind belongs to this bot.
 */
export async function redirectForeignInvitation(
  ctx: BotContext,
  env: Env,
  here: BotKind,
  kind: InvitationKind,
): Promise<boolean> {
  const target = INVITATION_BOT[kind];
  if (target === here) return false;
  const username = botConfigs(env)[target].username;
  const kb = new InlineKeyboard().url(ctx.t(`btn-open-${target}-bot`), `https://t.me/${username}`);
  await say(ctx, ctx.t(`invite-wrong-bot-${target}`), kb);
  return true;
}
