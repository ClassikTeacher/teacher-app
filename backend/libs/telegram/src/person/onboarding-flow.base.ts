import { AppError, type ErrorCode } from '@shared/errors/app-error.js';
import type { TelegramIdentity } from '@modules/identity/redeem-staff-invitation.use-case.js';
import type { BotContext } from '../core/context.js';
import { Flow } from '../core/flow.js';
import { type PersonOnboardingData } from './onboarding-steps.js';
import { identityOf } from './person-bot.js';

/** Failures after which the questionnaire cannot succeed on retry: the dialog is dropped, the error shown. */
const TERMINAL: readonly ErrorCode[] = [
  'INVITATION_INVALID',
  'INVITATION_NOT_FOR_YOU',
  'LIMIT_EXCEEDED',
  'ACCOUNT_BLOCKED',
  'VALIDATION_ERROR',
];

/** Shared completion of the student/parent questionnaire: accept the invitation, or drop the dialog on terminal errors. */
export abstract class PersonOnboardingFlow extends Flow<PersonOnboardingData> {
  readonly firstStep = 'name';

  protected abstract acceptWith(
    ctx: BotContext,
    user: TelegramIdentity,
    chatId: number,
    d: PersonOnboardingData,
  ): Promise<void>;

  async complete(ctx: BotContext, d: PersonOnboardingData): Promise<void> {
    const user = identityOf(ctx);
    if (!user || !ctx.chat) return;
    try {
      await this.acceptWith(ctx, user, ctx.chat.id, d);
    } catch (error) {
      if (AppError.is(error) && TERMINAL.includes(error.code)) ctx.session.flow = undefined;
      throw error;
    }
  }
}
