import type { BotKind } from '@shared/config/env.schema.js';
import { type Actor, isStaff } from '@modules/access/actor.js';
import { INVITATION_TOKEN } from '@modules/identity/invitation.rules.js';
import type { PeekedInvitation } from '@modules/identity/invitation.service.js';
import type { TelegramIdentity } from '@modules/identity/redeem-staff-invitation.use-case.js';
import type { InvitationKind, Role } from '@modules/identity/schema.js';
import type { CreatedBot } from '../core/bot-factory.js';
import { parseCb } from '../core/callback.js';
import { syncChatCommands } from '../core/commands.js';
import type { BotContext } from '../core/context.js';
import { requireActor } from '../core/guards.js';
import { SECTION_NS, type SectionModule } from '../core/sections.js';
import { ack, renderMenu, say } from '../core/ui.js';
import type { BotDefinition } from '../gateway/bot-definition.js';
import { renderSoon, sectionGrid } from './person-menu.js';

export interface PersonBotTexts {
  stranger: string;
  onboarding: string;
  notAllowed: string;
  help: string;
  mainMenu: string;
}

/** What a bot knows about a deep link before it is accepted. */
export interface InvitationPreview {
  invitation: PeekedInvitation;
}

/** Telegram identity of the current user, as use-cases expect it. */
export function identityOf(ctx: BotContext): TelegramIdentity | null {
  if (!ctx.from) return null;
  return {
    id: ctx.from.id,
    firstName: ctx.from.first_name,
    lastName: ctx.from.last_name,
    username: ctx.from.username,
  };
}

/**
 * Common wiring of StudentBot and ParentBot (4.2, 4.4): private chats only, `/start <token>` before the
 * gate (strangers arrive through invitations), the gate itself (role + status), an onboarding dialog that
 * runs while the person has no active account yet, the single editable menu and `s:` section routing.
 */
export abstract class PersonBot<K extends string, P extends InvitationPreview> implements BotDefinition {
  abstract readonly kind: BotKind;
  readonly commands = [
    { command: 'menu', description: 'Главное меню' },
    { command: 'help', description: 'Справка' },
    { command: 'cancel', description: 'Прервать текущий диалог' },
  ];
  protected abstract readonly role: Role;
  protected abstract readonly sectionKeys: readonly K[];
  /** i18n key prefix of section labels, e.g. `smenu`. */
  protected abstract readonly menuPrefix: string;
  protected abstract readonly texts: PersonBotTexts;
  /** Flow that strangers may run before they have an active account. */
  protected abstract readonly onboardingFlowName: string;
  protected readonly modules = new Map<K, SectionModule<K>>();

  protected constructor(sections: ReadonlyArray<SectionModule<K>>) {
    for (const module of sections) this.modules.set(module.section, module);
  }

  protected abstract registerFlows(created: CreatedBot): void;
  /** Bot-specific `m:` callbacks that need an authorized actor (registered after the gate, before `m:`). */
  protected registerExtraCallbacks(_bot: CreatedBot['bot']): void {}
  /** Kind of deep link (`student` / `parent`) and a redirect for every other kind. */
  protected abstract peekKind(ctx: BotContext, token: string): Promise<InvitationKind | null>;
  protected abstract redirect(ctx: BotContext, kind: InvitationKind): Promise<boolean>;
  protected abstract peek(ctx: BotContext, token: string): Promise<P | null>;
  /** i18n key explaining why a valid link cannot be used by this person right now, or null. */
  protected abstract problemOf(
    ctx: BotContext,
    preview: P,
  ): Promise<{ key: string; vars?: Record<string, string> } | null>;
  protected abstract renderCard(ctx: BotContext, preview: P, token: string): Promise<void>;
  /** The person already has an active account: accept without a questionnaire. */
  protected abstract acceptExisting(
    ctx: BotContext,
    user: TelegramIdentity,
    token: string,
    chatId: number,
  ): Promise<void>;
  protected abstract startOnboarding(ctx: BotContext, preview: P, token: string): Promise<void>;
  protected abstract decline(ctx: BotContext, user: TelegramIdentity, token: string): Promise<void>;

  /** Only people with the bot's role get a `bot_chat` row here (notifications must not reach role-less chats). */
  registersChatFor(actor: Actor): boolean {
    return actor.roles.includes(this.role);
  }

  setup(created: CreatedBot): void {
    const { bot, flows } = created;
    this.registerFlows(created);
    for (const module of this.modules.values()) module.register?.(created);

    bot.use(async (ctx, next) => {
      if (ctx.chat?.type !== 'private') return; // invitation tokens are never handled in groups
      await next();
    });
    bot.command('start', async (ctx) => {
      await flows.cancel(ctx);
      await this.onStart(ctx);
    });
    bot.command('help', async (ctx) => say(ctx, ctx.t(this.texts.help)));
    bot.command('cancel', async (ctx) => {
      const cancelled = await flows.cancel(ctx);
      await say(ctx, ctx.t(cancelled ? 'cancel-done' : 'cancel-nothing'));
    });
    bot.callbackQuery(/^m:inv:/, async (ctx) => {
      const parsed = parseCb(ctx.callbackQuery.data);
      await ack(ctx);
      if (!parsed) return;
      const [action = '', ...args] = parsed.args;
      await this.onInvitationCallback(ctx, action, args);
    });

    const gate = requireActor({ allow: (actor) => actor.roles.includes(this.role), texts: this.texts });
    bot.use(async (ctx, next) => {
      // the questionnaire runs before the account is active (or exists): the flow was started from a valid token
      const inOnboarding = ctx.session.flow?.name === this.onboardingFlowName;
      if (inOnboarding && (!ctx.actor || ctx.actor.account.status === 'onboarding')) return next();
      return gate(ctx, next);
    });
    bot.use(async (ctx, next) => {
      if (ctx.chat && ctx.actor && ctx.session.commandsSyncedFor !== this.role) {
        await syncChatCommands(bot, ctx.chat.id, this.commands);
        ctx.session.commandsSyncedFor = this.role;
      }
      await next();
    });

    bot.command('menu', async (ctx) => {
      await flows.cancel(ctx);
      await this.showMain(ctx);
    });
    this.registerExtraCallbacks(bot);
    bot.callbackQuery(/^m:/, async (ctx) => {
      const parsed = parseCb(ctx.callbackQuery.data);
      await ack(ctx);
      if (!parsed || !ctx.actor) return;
      await flows.cancel(ctx); // navigation leaves an unfinished dialog
      if (parsed.action === 'open' && parsed.args[0])
        return this.openSection(ctx, ctx.actor.actor, parsed.args[0]);
      return this.showMain(ctx);
    });
    bot.callbackQuery(new RegExp(`^${SECTION_NS}:`), async (ctx) => {
      const parsed = parseCb(ctx.callbackQuery.data);
      const module = parsed && this.isSection(parsed.action) ? this.modules.get(parsed.action) : undefined;
      if (!module?.onCallback || !ctx.actor) return ack(ctx, ctx.t('callback-stale'));
      const [action = '', ...args] = parsed!.args;
      await ack(ctx);
      await module.onCallback(ctx, ctx.actor.actor, action, args);
    });
  }

  async showMain(ctx: BotContext): Promise<void> {
    if (!ctx.actor) return;
    const text = ctx.t(this.texts.mainMenu, { name: ctx.actor.account.firstName });
    await renderMenu(ctx, text, sectionGrid(ctx, this.menuPrefix, this.sectionKeys));
  }

  protected isSection(value: string): value is K {
    return (this.sectionKeys as readonly string[]).includes(value);
  }

  private async openSection(ctx: BotContext, actor: Actor, raw: string): Promise<void> {
    if (!this.isSection(raw)) return this.showMain(ctx);
    const module = this.modules.get(raw);
    if (module) return module.open(ctx, actor);
    await renderSoon(ctx, ctx.t(`${this.menuPrefix}-${raw}`));
  }

  /** `/start [token]`: the invitation card, a redirect to the right bot, or status-aware help. */
  private async onStart(ctx: BotContext): Promise<void> {
    const token = (ctx.match ?? '').toString().trim();
    if (!token) return this.startWithoutToken(ctx);
    if (!INVITATION_TOKEN.test(token) || !ctx.from) return say(ctx, ctx.t('invite-invalid'));
    if (ctx.actor?.account.status === 'blocked') return say(ctx, ctx.t('account-blocked'));
    const kind = await this.peekKind(ctx, token);
    if (!kind) return say(ctx, ctx.t('invite-invalid'));
    if (await this.redirect(ctx, kind)) return;
    await this.showInvitation(ctx, token);
  }

  /** Validates the link for this person and renders the card, or explains why it cannot be used. */
  private async showInvitation(ctx: BotContext, token: string): Promise<P | null> {
    const preview = await this.peek(ctx, token);
    if (!preview) {
      await say(ctx, ctx.t('invite-invalid'));
      return null;
    }
    const check = preview.invitation.check;
    if (!check.ok) {
      await say(ctx, ctx.t(`invite-${check.reason.replace(/_/g, '-')}`));
      return null;
    }
    const problem = await this.problemOf(ctx, preview);
    if (problem) {
      await say(ctx, ctx.t(problem.key, problem.vars));
      return null;
    }
    ctx.session.flow = undefined;
    await this.renderCard(ctx, preview, token);
    return preview;
  }

  private async onInvitationCallback(ctx: BotContext, action: string, args: string[]): Promise<void> {
    const token = args[0];
    const user = identityOf(ctx);
    if (!user || !ctx.chat || !token || !INVITATION_TOKEN.test(token))
      return say(ctx, ctx.t('callback-stale'));
    if (ctx.actor?.account.status === 'blocked') return say(ctx, ctx.t('account-blocked'));
    if (action === 'decline') return this.decline(ctx, user, token);
    if (action !== 'accept') return say(ctx, ctx.t('callback-stale'));
    // re-validated at press time: the card may be stale (expired, revoked, limit reached meanwhile)
    const preview = await this.peek(ctx, token);
    const problem = preview?.invitation.check.ok ? await this.problemOf(ctx, preview) : null;
    if (!preview || !preview.invitation.check.ok || problem) {
      await this.showInvitation(ctx, token);
      return;
    }
    if (ctx.actor?.account.status === 'active') return this.acceptExisting(ctx, user, token, ctx.chat.id);
    // a staff account that has not finished its own questionnaire must not be activated by this one (M1-M2 review M-1)
    if (ctx.actor && isStaff(ctx.actor.actor)) return say(ctx, ctx.t('staff-finish-onboarding'));
    await this.startOnboarding(ctx, preview, token);
  }

  private async startWithoutToken(ctx: BotContext): Promise<void> {
    const resolved = ctx.actor;
    if (!resolved) return say(ctx, ctx.t(this.texts.stranger));
    if (resolved.account.status === 'blocked') return say(ctx, ctx.t('account-blocked'));
    if (resolved.actor.status === 'active' && resolved.actor.roles.includes(this.role))
      return this.showMain(ctx);
    await say(ctx, ctx.t(this.texts.notAllowed));
  }
}
