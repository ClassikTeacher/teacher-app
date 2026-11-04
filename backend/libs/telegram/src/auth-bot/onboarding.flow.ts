import { Inject, Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { botConfigs, ENV, type Env } from '@shared/config/index.js';
import { COMMON_TIMEZONES, isValidTimezone } from '@shared/time/timezone.js';
import { CONSENT_VERSION } from '@modules/identity/consent.js';
import type { Role } from '@modules/identity/schema.js';
import { CompleteStaffOnboardingUseCase } from '@modules/people/complete-staff-onboarding.use-case.js';
import { SubjectRepository } from '@modules/people/subject.repository.js';
import {
  DEFAULT_LESSON_DURATION_MIN,
  DEFAULT_NOTICE_TEXT,
} from '@modules/people/teacher-profile.defaults.js';
import type { BotContext } from '../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../core/flow.js';
import { escapeHtml, renderMenu, say } from '../core/ui.js';
import { teacherSteps } from './onboarding.teacher-steps.js';

export interface OnboardingData extends Record<string, unknown> {
  accountId: string;
  role: Role;
  invitedBy: string | null;
  firstName: string;
  lastName: string;
  subjectIds: string[];
  subjectsPage: number;
  timezone: string;
  durationMin: number;
  noticeText: string;
}

export interface OnboardingStart {
  accountId: string;
  role: Role;
  invitedBy: string | null;
}

const MAX_NAME_LENGTH = 60;
const MAX_BUTTON_LABEL = 40;

/** Questionnaire of 5.1.2: name → (subjects) → timezone → (duration → notice) → consent. */
@Injectable()
export class OnboardingFlow extends Flow<OnboardingData> {
  readonly name = 'onboarding';
  readonly firstStep = 'name';
  readonly steps: Record<string, FlowStep<OnboardingData>>;

  constructor(
    @Inject(ENV) private readonly env: Env,
    subjects: SubjectRepository,
    private readonly completeOnboarding: CompleteStaffOnboardingUseCase,
  ) {
    super();
    this.steps = { ...this.baseSteps(), ...teacherSteps(subjects) };
  }

  async initial(ctx: BotContext, arg: unknown): Promise<OnboardingData> {
    const start = arg as OnboardingStart;
    return {
      ...start,
      firstName: ctx.from?.first_name ?? '',
      lastName: ctx.from?.last_name ?? '',
      subjectIds: [],
      subjectsPage: 1,
      timezone: this.env.PLATFORM_TIMEZONE,
      durationMin: DEFAULT_LESSON_DURATION_MIN,
      noticeText: DEFAULT_NOTICE_TEXT,
    };
  }

  private baseSteps(): Record<string, FlowStep<OnboardingData>> {
    const afterName = (d: OnboardingData): FlowNext => ({
      goto: d.role === 'TEACHER' ? 'subjects' : 'timezone',
    });
    const afterTimezone = (d: OnboardingData): FlowNext => ({
      goto: d.role === 'TEACHER' ? 'duration' : 'consent',
    });
    return {
      name: {
        enter: async (ctx, d) => {
          const full = `${d.firstName} ${d.lastName}`.trim();
          const label = full.length > MAX_BUTTON_LABEL ? `${full.slice(0, MAX_BUTTON_LABEL - 1)}…` : full;
          const kb = new InlineKeyboard().text(
            ctx.t('btn-keep-name', { name: label }),
            flowCb('name', 'keep'),
          );
          await renderMenu(ctx, ctx.t('onb-name', { name: escapeHtml(full) }), kb);
        },
        onCallback: async (_ctx, d, action) => (action === 'keep' ? afterName(d) : { stay: true }),
        onText: async (ctx, d, text) => {
          const [first, ...rest] = text.split(/\s+/).filter(Boolean);
          if (!first || text.length > MAX_NAME_LENGTH) {
            await say(ctx, ctx.t('onb-name-invalid'));
            return { stay: true };
          }
          d.firstName = first;
          d.lastName = rest.join(' ');
          return afterName(d);
        },
      },
      timezone: {
        enter: async (ctx, d) => {
          const kb = new InlineKeyboard();
          COMMON_TIMEZONES.forEach((zone, i) => {
            kb.text(zone, flowCb('timezone', 'tz', zone));
            if (i % 2 === 1) kb.row();
          });
          await renderMenu(ctx, ctx.t('onb-timezone', { current: d.timezone }), kb);
        },
        onCallback: async (_ctx, d, action, args) => {
          if (action === 'tz' && args[0] && isValidTimezone(args[0])) {
            d.timezone = args[0];
            return afterTimezone(d);
          }
          return { stay: true };
        },
        onText: async (ctx, d, text) => {
          if (!isValidTimezone(text)) {
            await say(ctx, ctx.t('onb-timezone-invalid'));
            return { stay: true };
          }
          d.timezone = text;
          return afterTimezone(d);
        },
      },
      consent: {
        enter: async (ctx) => {
          const kb = new InlineKeyboard().text(ctx.t('btn-accept-consent'), flowCb('consent', 'accept'));
          await renderMenu(ctx, ctx.t('onb-consent', { version: CONSENT_VERSION }), kb);
        },
        onCallback: async (ctx, _d, action) => {
          if (action !== 'accept') return { stay: true };
          // AUTH-04: staff must have a Telegram username; re-checked here because it can be set meanwhile.
          if (!ctx.from?.username) {
            await say(ctx, ctx.t('username-required'));
            return { stay: true };
          }
          return { done: true };
        },
        onText: async (ctx) => {
          await say(ctx, ctx.t('onb-consent-button'));
          return { stay: true };
        },
      },
    };
  }

  async complete(ctx: BotContext, d: OnboardingData): Promise<void> {
    await this.completeOnboarding.execute({
      accountId: d.accountId,
      firstName: d.firstName,
      lastName: d.lastName,
      username: ctx.from?.username ?? null,
      timezone: d.timezone,
      locale: 'ru',
      consentVersion: CONSENT_VERSION,
      invitedBy: d.invitedBy,
      teacher:
        d.role === 'TEACHER'
          ? { subjectIds: d.subjectIds, defaultDurationMin: d.durationMin, defaultNoticeText: d.noticeText }
          : undefined,
    });
    const staffLink = `https://t.me/${botConfigs(this.env).staff.username}`;
    await renderMenu(
      ctx,
      ctx.t('onb-done'),
      new InlineKeyboard().url(ctx.t('btn-open-staff-bot'), staffLink),
    );
  }
}
