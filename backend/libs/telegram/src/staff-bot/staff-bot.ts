import { Inject, Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { botConfigs, ENV, type Env } from '@shared/config/index.js';
import { type Actor, isAdmin } from '@modules/access/actor.js';
import { FeatureService } from '@modules/access/features/feature.service.js';
import type { ResolvedFeatures } from '@modules/access/features/rules.js';
import type { CreatedBot } from '../core/bot-factory.js';
import { parseCb } from '../core/callback.js';
import { syncChatCommands } from '../core/commands.js';
import type { BotContext } from '../core/context.js';
import { requireActor } from '../core/guards.js';
import { ack, renderMenu, say } from '../core/ui.js';
import type { BotDefinition } from '../gateway/bot-definition.js';
import { backKeyboard, buildAdminMenu, buildMainMenu } from './menu.js';
import { SECTION_NS, STAFF_SECTIONS, type StaffSectionModule } from './section-module.js';
import { canOpen, isStaffSection, SECTION_BY_KEY, type StaffSection } from './sections.js';

/** StaffBot (4.2): the working bot of teachers and admins. Menu and access derive from roles and features. */
@Injectable()
export class StaffBot implements BotDefinition {
  readonly kind = 'staff' as const;
  readonly commands = [
    { command: 'menu', description: 'Главное меню' },
    { command: 'help', description: 'Справка' },
    { command: 'cancel', description: 'Прервать текущий диалог' },
  ];
  private readonly modules = new Map<StaffSection, StaffSectionModule>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly features: FeatureService,
    @Inject(STAFF_SECTIONS) sections: StaffSectionModule[],
  ) {
    for (const module of sections) this.modules.set(module.section, module);
  }

  setup(created: CreatedBot): void {
    const { bot, flows } = created;
    bot.use(
      requireActor({
        allow: (actor) => actor.roles.includes('TEACHER') || isAdmin(actor),
        texts: {
          stranger: 'staff-need-invite',
          onboarding: 'staff-finish-onboarding',
          notAllowed: 'staff-not-staff',
        },
        keyboard: (ctx) => this.authKeyboard(ctx),
        onRefused: async (ctx) => {
          if (ctx.chat)
            await bot.api
              .deleteMyCommands({ scope: { type: 'chat', chat_id: ctx.chat.id } })
              .catch(() => undefined);
        },
      }),
    );
    bot.use(async (ctx, next) => {
      // Chat-scoped commands follow the role set; synced once per role change (4.4).
      const roles = ctx.actor?.actor.roles.join(',') ?? '';
      if (ctx.chat && ctx.session.commandsSyncedFor !== roles) {
        // Best effort: a Telegram hiccup here must not block the update (syncChatCommands swallows errors).
        await syncChatCommands(bot, ctx.chat.id, this.commands);
        ctx.session.commandsSyncedFor = roles;
      }
      await next();
    });
    for (const module of this.modules.values()) module.register?.(created);

    bot.command(['start', 'menu'], async (ctx) => {
      await flows.cancel(ctx);
      await this.showMain(ctx);
    });
    bot.command('help', async (ctx) => say(ctx, ctx.t('staff-help')));
    bot.command('cancel', async (ctx) => {
      const cancelled = await flows.cancel(ctx);
      await say(ctx, ctx.t(cancelled ? 'cancel-done' : 'cancel-nothing'));
      if (cancelled) await this.showMain(ctx);
    });

    bot.callbackQuery(/^m:/, async (ctx) => {
      const parsed = parseCb(ctx.callbackQuery.data);
      await ack(ctx);
      if (!parsed || !ctx.actor) return;
      await flows.cancel(ctx); // any navigation leaves an unfinished dialog
      const actor = ctx.actor.actor;
      const features = await this.featuresOf(actor);
      if (parsed.action === 'admin') {
        if (!isAdmin(actor)) return this.showMain(ctx);
        const { text, keyboard } = buildAdminMenu(ctx, actor, features);
        return renderMenu(ctx, text, keyboard);
      }
      if (parsed.action === 'open' && parsed.args[0])
        return this.openSection(ctx, actor, features, parsed.args[0]);
      return this.showMain(ctx);
    });

    // Section buttons `s:<section>:<action>` pass the same role/feature check as the menu entry.
    bot.callbackQuery(new RegExp(`^${SECTION_NS}:`), async (ctx) => {
      const parsed = parseCb(ctx.callbackQuery.data);
      if (!parsed || !ctx.actor || !isStaffSection(parsed.action)) return ack(ctx, ctx.t('callback-stale'));
      const actor = ctx.actor.actor;
      const section = parsed.action;
      const module = this.modules.get(section);
      if (!module?.onCallback || !canOpen(section, actor, await this.featuresOf(actor))) {
        return ack(ctx, ctx.t('error-forbidden'));
      }
      const [action = '', ...args] = parsed.args;
      await ack(ctx);
      await module.onCallback(ctx, actor, action, args);
    });
  }

  async showMain(ctx: BotContext): Promise<void> {
    if (!ctx.actor) return;
    const actor = ctx.actor.actor;
    const { text, keyboard } = buildMainMenu(ctx, actor, await this.featuresOf(actor));
    await renderMenu(ctx, text, keyboard);
  }

  private async openSection(
    ctx: BotContext,
    actor: Actor,
    features: ResolvedFeatures | null,
    raw: string,
  ): Promise<void> {
    if (!isStaffSection(raw) || !canOpen(raw, actor, features)) {
      await say(ctx, ctx.t('error-forbidden'));
      return this.showMain(ctx);
    }
    const module = this.modules.get(raw);
    if (module) return module.open(ctx, actor);
    const parent = SECTION_BY_KEY.get(raw)!.parent;
    await renderMenu(
      ctx,
      ctx.t('staff-section-soon', { section: ctx.t(`menu-${raw}`) }),
      backKeyboard(ctx, parent),
    );
  }

  /** Feature flags matter only for teacher sections; admins without the teacher role have none. */
  private async featuresOf(actor: Actor): Promise<ResolvedFeatures | null> {
    return actor.roles.includes('TEACHER') ? this.features.resolve(actor.accountId) : null;
  }

  private authKeyboard(ctx: BotContext): InlineKeyboard {
    return new InlineKeyboard().url(
      ctx.t('btn-open-auth-bot'),
      `https://t.me/${botConfigs(this.env).auth.username}`,
    );
  }
}
