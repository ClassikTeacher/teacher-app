import { Inject, Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { ENV, type Env } from '@shared/config/index.js';
import { CONSENT_VERSION } from '@modules/identity/consent.js';
import type { TelegramIdentity } from '@modules/identity/redeem-staff-invitation.use-case.js';
import { AcceptStudentInvitationUseCase } from '@modules/people/links/accept-student-invitation.use-case.js';
import type { BotContext } from '../core/context.js';
import type { FlowStep } from '../core/flow.js';
import { fullName } from '../core/format.js';
import { escapeHtml, renderMenu } from '../core/ui.js';
import { PersonOnboardingFlow } from '../person/onboarding-flow.base.js';
import { type PersonOnboardingData, personSteps } from '../person/onboarding-steps.js';
import { menuCb } from '../person/person-menu.js';

export interface StudentOnboardingStart {
  token: string;
  teacherName: string;
  grade: string;
}

/** UC-10 step 6: name → class → timezone → consent, then the invitation is accepted in one transaction. */
@Injectable()
export class StudentOnboardingFlow extends PersonOnboardingFlow {
  readonly name = 'student-onboarding';
  readonly steps: Record<string, FlowStep<PersonOnboardingData>> = personSteps({
    prefix: 'sonb',
    afterName: 'grade',
    afterGrade: 'timezone',
    afterTimezone: 'consent',
  });

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly accept: AcceptStudentInvitationUseCase,
  ) {
    super();
  }

  async initial(ctx: BotContext, arg: unknown): Promise<PersonOnboardingData> {
    const start = arg as StudentOnboardingStart;
    return {
      token: start.token,
      teacherName: start.teacherName,
      childName: '',
      grade: start.grade,
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
        grade: d.grade || null,
        timezone: d.timezone,
        consentVersion: CONSENT_VERSION,
      },
    });
    await renderMenu(
      ctx,
      ctx.t('sonb-done', { teacher: escapeHtml(fullName(result.teacher)) }),
      new InlineKeyboard().text(ctx.t('btn-open-menu'), menuCb('main')),
    );
  }
}
