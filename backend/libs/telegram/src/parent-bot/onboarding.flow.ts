import { Inject, Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { ENV, type Env } from '@shared/config/index.js';
import { CONSENT_VERSION } from '@modules/identity/consent.js';
import type { TelegramIdentity } from '@modules/identity/redeem-staff-invitation.use-case.js';
import { AcceptParentInvitationUseCase } from '@modules/people/family/accept-parent-invitation.use-case.js';
import type { BotContext } from '../core/context.js';
import type { FlowStep } from '../core/flow.js';
import { fullName } from '../core/format.js';
import { escapeHtml, renderMenu } from '../core/ui.js';
import { PersonOnboardingFlow } from '../person/onboarding-flow.base.js';
import { type PersonOnboardingData, personSteps } from '../person/onboarding-steps.js';
import { menuCb } from '../person/person-menu.js';

export interface ParentOnboardingStart {
  token: string;
  teacherName: string;
  childName: string;
}

/** UC-11 step 3 for a new parent: name → timezone → consent (own data and the child's), then the link is created. */
@Injectable()
export class ParentOnboardingFlow extends PersonOnboardingFlow {
  readonly name = 'parent-onboarding';
  readonly steps: Record<string, FlowStep<PersonOnboardingData>> = personSteps({
    prefix: 'ponb',
    afterName: 'timezone',
    afterTimezone: 'consent',
  });

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly accept: AcceptParentInvitationUseCase,
  ) {
    super();
  }

  async initial(ctx: BotContext, arg: unknown): Promise<PersonOnboardingData> {
    const start = arg as ParentOnboardingStart;
    return {
      token: start.token,
      teacherName: start.teacherName,
      childName: start.childName,
      grade: '',
      firstName: ctx.from?.first_name ?? '',
      lastName: ctx.from?.last_name ?? '',
      timezone: this.env.PLATFORM_TIMEZONE,
    };
  }

  protected async acceptWith(
    ctx: BotContext,
    user: TelegramIdentity,
    chatId: number,
    d: PersonOnboardingData,
  ): Promise<void> {
    const result = await this.accept.accept({
      user,
      token: d.token,
      chatId,
      questionnaire: {
        firstName: d.firstName,
        lastName: d.lastName,
        timezone: d.timezone,
        consentVersion: CONSENT_VERSION,
      },
      consentVersion: CONSENT_VERSION,
    });
    await renderMenu(
      ctx,
      ctx.t('ponb-done', { child: escapeHtml(fullName(result.student)) }),
      new InlineKeyboard().text(ctx.t('btn-open-menu'), menuCb('main')),
    );
  }
}
