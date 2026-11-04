import { Inject, Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { botConfigs, ENV, type Env } from '@shared/config/index.js';
import { AppError } from '@shared/errors/app-error.js';
import { isUuid } from '@shared/ids/index.js';
import { INVITATION_TOKEN } from '@modules/identity/invitation.rules.js';
import { RedeemStaffInvitationUseCase } from '@modules/identity/redeem-staff-invitation.use-case.js';
import { SuperAdminTransferUseCase } from '@modules/identity/super-admin-transfer.use-case.js';
import type { Role } from '@modules/identity/schema.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import type { CreatedBot } from '../core/bot-factory.js';
import { cb, MENU_NS, parseCb } from '../core/callback.js';
import type { BotContext } from '../core/context.js';
import { ack, say } from '../core/ui.js';
import type { BotDefinition } from '../gateway/bot-definition.js';
import { OnboardingFlow } from './onboarding.flow.js';

/** AuthBot (4.2): accepts staff invitations and runs onboarding. No work functions. Private chats only. */
@Injectable()
export class AuthBot implements BotDefinition {
  readonly kind = 'auth' as const;
  readonly commands = [
    { command: 'start', description: 'Принять приглашение' },
    { command: 'help', description: 'Справка' },
    { command: 'cancel', description: 'Прервать текущий диалог' },
  ];

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly redeem: RedeemStaffInvitationUseCase,
    private readonly profiles: TeacherProfileRepository,
    private readonly onboarding: OnboardingFlow,
    private readonly transfers: SuperAdminTransferUseCase,
  ) {}

  setup({ bot, flows }: CreatedBot): void {
    flows.register(this.onboarding);
    bot.use(async (ctx, next) => {
      if (ctx.chat?.type !== 'private') return; // invitation tokens must never be handled in groups
      await next();
    });
    bot.command('cancel', async (ctx) => {
      const cancelled = await flows.cancel(ctx);
      await say(ctx, ctx.t(cancelled ? 'cancel-done' : 'cancel-nothing'));
    });
    bot.command('help', async (ctx) => say(ctx, ctx.t('auth-help')));
    bot.command('start', async (ctx) => this.onStart(ctx));
    bot.callbackQuery(/^m:sat:/, async (ctx) => this.onTransferCallback(ctx));
    bot.callbackQuery(/^m:/, async (ctx) => this.onMenuCallback(ctx));
  }

  private async onStart(ctx: BotContext): Promise<void> {
    const token = (ctx.match ?? '').toString().trim();
    if (!token) return this.startWithoutToken(ctx);
    if (!INVITATION_TOKEN.test(token) || !ctx.from) return say(ctx, ctx.t('invite-invalid'));

    const peeked = await this.redeem.peek(token, ctx.from.id);
    if (!peeked) return say(ctx, ctx.t('invite-invalid'));
    if (!peeked.check.ok) return say(ctx, ctx.t(`invite-${peeked.check.reason.replace(/_/g, '-')}`));

    // INV-04 / UC-04 2а: an existing platform account confirms before a new role is added.
    if (ctx.actor && ctx.actor.actor.roles.length > 0) {
      ctx.session.flow = undefined;
      ctx.session.menuMessageId = undefined;
      const keyboard = new InlineKeyboard()
        .text(ctx.t('btn-yes'), cb(MENU_NS, 'redeem', token))
        .text(ctx.t('btn-no'), cb(MENU_NS, 'decline'));
      return say(ctx, ctx.t('invite-add-role', { role: ctx.t(`role-${peeked.kind}`) }), keyboard);
    }
    await this.redeemAndContinue(ctx, token);
  }

  private async onMenuCallback(ctx: BotContext): Promise<void> {
    const parsed = parseCb(ctx.callbackQuery?.data);
    await ack(ctx);
    if (parsed?.action === 'redeem' && parsed.args[0]) return this.redeemAndContinue(ctx, parsed.args[0]);
    if (parsed?.action === 'decline') return say(ctx, ctx.t('invite-declined'));
  }

  private async redeemAndContinue(ctx: BotContext, token: string): Promise<void> {
    if (!ctx.from) return;
    const result = await this.redeem.execute(
      {
        id: ctx.from.id,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
        username: ctx.from.username,
      },
      token,
    );
    if (result.requiresOnboarding) {
      return this.onboarding.start(ctx, {
        accountId: result.account.id,
        role: result.role,
        invitedBy: result.invitedBy,
      });
    }
    await say(
      ctx,
      ctx.t('invite-role-added', { role: ctx.t(`role-${result.role.toLowerCase()}`) }),
      this.staffKeyboard(ctx),
    );
  }

  /** UC-02: the designated account confirms or declines the super admin transfer (buttons come with the notification). */
  private async onTransferCallback(ctx: BotContext): Promise<void> {
    const parsed = parseCb(ctx.callbackQuery?.data);
    await ack(ctx);
    const transferId = parsed?.args[1];
    const decision = parsed?.args[0];
    if (!ctx.actor || !isUuid(transferId) || (decision !== 'confirm' && decision !== 'decline')) {
      return say(ctx, ctx.t('callback-stale'));
    }
    if (ctx.actor.account.status === 'blocked') return say(ctx, ctx.t('account-blocked'));
    const row =
      decision === 'confirm'
        ? await this.transfers.confirm(transferId, ctx.actor.account.id)
        : await this.transfers.decline(transferId, ctx.actor.account.id);
    await say(
      ctx,
      ctx.t(row.status === 'confirmed' ? 'sat-confirmed' : 'sat-declined'),
      this.staffKeyboard(ctx),
    );
  }

  /** `/start` without a token: status-aware help, including resuming an unfinished questionnaire. */
  private async startWithoutToken(ctx: BotContext): Promise<void> {
    const resolved = ctx.actor;
    if (!resolved) return say(ctx, ctx.t('auth-need-invite'));
    const { account, actor } = resolved;
    if (account.status === 'blocked') return say(ctx, ctx.t('account-blocked'));
    const pendingTransfer = await this.transfers.findPendingFor(account.id);
    if (pendingTransfer) {
      const kb = new InlineKeyboard()
        .text(ctx.t('btn-sat-confirm'), `m:sat:confirm:${pendingTransfer.id}`)
        .text(ctx.t('btn-sat-decline'), `m:sat:decline:${pendingTransfer.id}`);
      return say(ctx, ctx.t('sat-pending'), kb);
    }
    const role = this.pendingOnboardingRole(
      actor.roles,
      account.status,
      await this.profiles.find(account.id),
    );
    if (role) {
      await say(ctx, ctx.t('auth-resume-onboarding'));
      return this.onboarding.start(ctx, { accountId: account.id, role, invitedBy: null });
    }
    if (account.status === 'active') return say(ctx, ctx.t('auth-already-active'), this.staffKeyboard(ctx));
    throw new AppError('FORBIDDEN', 'Account without roles cannot be onboarded');
  }

  /** A teacher without a completed profile or any staff account still in `onboarding` must (re)take the questionnaire. */
  private pendingOnboardingRole(
    roles: readonly Role[],
    status: string,
    profile: { onboardedAt: Date | null } | null,
  ): Role | null {
    if (roles.includes('TEACHER') && !profile?.onboardedAt) return 'TEACHER';
    if (status === 'onboarding') return roles.find((r) => r === 'SUPER_ADMIN' || r === 'ADMIN') ?? null;
    return null;
  }

  private staffKeyboard(ctx: BotContext): InlineKeyboard {
    return new InlineKeyboard().url(
      ctx.t('btn-open-staff-bot'),
      `https://t.me/${botConfigs(this.env).staff.username}`,
    );
  }
}
