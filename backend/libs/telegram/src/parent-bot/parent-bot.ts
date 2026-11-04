import { Inject, Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { ENV, type Env } from '@shared/config/index.js';
import { CONSENT_VERSION } from '@modules/identity/consent.js';
import { InvitationService } from '@modules/identity/invitation.service.js';
import type { TelegramIdentity } from '@modules/identity/redeem-staff-invitation.use-case.js';
import type { InvitationKind } from '@modules/identity/schema.js';
import {
  AcceptParentInvitationUseCase,
  type ParentInvitationPreview,
} from '@modules/people/family/accept-parent-invitation.use-case.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { isUuid } from '@shared/ids/index.js';
import type { CreatedBot } from '../core/bot-factory.js';
import { cb, MENU_NS, parseCb } from '../core/callback.js';
import type { BotContext } from '../core/context.js';
import { fullName } from '../core/format.js';
import type { SectionModule } from '../core/sections.js';
import { ack, escapeHtml, renderMenu, say } from '../core/ui.js';
import { redirectForeignInvitation } from '../person/invite-redirect.js';
import { PersonBot, type PersonBotTexts } from '../person/person-bot.js';
import { menuCb } from '../person/person-menu.js';
import { ParentOnboardingFlow } from './onboarding.flow.js';
import { RequestsSection } from './requests.section.js';
import { PARENT_SECTION_MODULES, PARENT_SECTIONS, type ParentSection } from './sections.js';

/** ParentBot (4.2): accepts parent invitations (UC-11) and serves the parent menu (4.4). */
@Injectable()
export class ParentBot extends PersonBot<ParentSection, ParentInvitationPreview> {
  readonly kind = 'parent' as const;
  protected readonly role = 'PARENT' as const;
  protected readonly sectionKeys = PARENT_SECTIONS;
  protected readonly menuPrefix = 'pmenu';
  protected readonly onboardingFlowName: string;
  protected readonly texts: PersonBotTexts = {
    stranger: 'parent-need-invite',
    onboarding: 'parent-need-invite',
    notAllowed: 'parent-not-parent',
    help: 'parent-help',
    mainMenu: 'parent-main-menu',
  };

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly invitations: InvitationService,
    private readonly accept: AcceptParentInvitationUseCase,
    private readonly family: FamilyLinkRepository,
    private readonly onboarding: ParentOnboardingFlow,
    private readonly requests: RequestsSection,
    @Inject(PARENT_SECTION_MODULES) sections: SectionModule<ParentSection>[],
  ) {
    super(sections);
    this.onboardingFlowName = onboarding.name;
  }

  protected registerFlows({ flows }: CreatedBot): void {
    flows.register(this.onboarding);
  }

  /** UC-35 from the notification buttons (`m:lr:ok|no:<requestId>`), after the gate. */
  protected override registerExtraCallbacks(bot: CreatedBot['bot']): void {
    bot.callbackQuery(/^m:lr:/, async (ctx) => {
      const parsed = parseCb(ctx.callbackQuery.data);
      await ack(ctx);
      const [decision, requestId] = parsed?.args ?? [];
      if (!ctx.actor || !isUuid(requestId) || (decision !== 'ok' && decision !== 'no'))
        return say(ctx, ctx.t('callback-stale'));
      await this.requests.decide(ctx, ctx.actor.actor, requestId, decision === 'ok');
    });
  }

  protected async peekKind(ctx: BotContext, token: string): Promise<InvitationKind | null> {
    return (await this.invitations.peek(token, ctx.from!.id, new Date()))?.kind ?? null;
  }

  protected redirect(ctx: BotContext, kind: InvitationKind): Promise<boolean> {
    return redirectForeignInvitation(ctx, this.env, this.kind, kind);
  }

  protected peek(ctx: BotContext, token: string): Promise<ParentInvitationPreview | null> {
    return this.accept.peek(token, ctx.from!.id);
  }

  /** UC-11 3в (the student), 5.4.3 (four parents), 8.0 (teacher no longer linked), already a parent. */
  protected async problemOf(ctx: BotContext, preview: ParentInvitationPreview) {
    if (preview.isStudentSelf) return { key: 'parent-invite-is-student' };
    if (!preview.teacherLinkActive) return { key: 'invite-invalid' };
    const child = escapeHtml(fullName(preview.student));
    if (ctx.actor && (await this.family.findActive(ctx.actor.account.id, preview.student.id))) {
      return { key: 'parent-already-linked', vars: { child } };
    }
    if (preview.limitReached) return { key: 'parent-limit-reached', vars: { child } };
    return null;
  }

  /** UC-11 step 3: "Я родитель (законный представитель) ученика N"; the text states the consent being given. */
  protected async renderCard(
    ctx: BotContext,
    preview: ParentInvitationPreview,
    token: string,
  ): Promise<void> {
    const kb = new InlineKeyboard()
      .text(ctx.t('btn-confirm-parent'), cb(MENU_NS, 'inv', 'accept', token))
      .text(ctx.t('btn-decline-invite'), cb(MENU_NS, 'inv', 'decline', token));
    await renderMenu(
      ctx,
      ctx.t('parent-invite-card', {
        child: escapeHtml(fullName(preview.student)),
        teacher: escapeHtml(fullName(preview.teacher)),
        version: CONSENT_VERSION,
      }),
      kb,
    );
  }

  /** UC-11 3а: an existing account (another child or another teacher) — no second onboarding. */
  protected async acceptExisting(
    ctx: BotContext,
    user: TelegramIdentity,
    token: string,
    chatId: number,
  ): Promise<void> {
    const result = await this.accept.accept({ user, token, chatId, consentVersion: CONSENT_VERSION });
    await renderMenu(
      ctx,
      ctx.t('ponb-done', { child: escapeHtml(fullName(result.student)) }),
      new InlineKeyboard().text(ctx.t('btn-open-menu'), menuCb('main')),
    );
  }

  protected startOnboarding(ctx: BotContext, preview: ParentInvitationPreview, token: string): Promise<void> {
    return this.onboarding.start(ctx, {
      token,
      teacherName: fullName(preview.teacher),
      childName: fullName(preview.student),
    });
  }

  /** The link stays valid: declining a parent card only closes the screen. */
  protected async decline(ctx: BotContext): Promise<void> {
    await renderMenu(ctx, ctx.t('parent-invite-declined'));
  }
}
