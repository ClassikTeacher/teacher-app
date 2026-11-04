import { InlineKeyboard } from 'grammy';
import { COMMON_TIMEZONES, isValidTimezone } from '@shared/time/timezone.js';
import { CONSENT_VERSION } from '@modules/identity/consent.js';
import { MAX_GRADE_LENGTH } from '@modules/people/links/link.rules.js';
import { MAX_PERSON_NAME_LENGTH } from '@modules/people/person-onboarding.service.js';
import { flowCb, type FlowNext, type FlowStep } from '../core/flow.js';
import { clip } from '../core/format.js';
import { escapeHtml, renderMenu, say } from '../core/ui.js';

/** Dialog state of the simplified questionnaire (3.8) shared by StudentBot and ParentBot. */
export interface PersonOnboardingData extends Record<string, unknown> {
  token: string;
  firstName: string;
  lastName: string;
  grade: string;
  timezone: string;
  /** For texts: who invited and (for parents) which child. */
  teacherName: string;
  childName: string;
}

export interface PersonStepOptions {
  /** i18n key prefix: `sonb` (student) or `ponb` (parent). */
  prefix: string;
  afterName: string;
  afterGrade?: string;
  afterTimezone: string;
}

/** Name (keep or retype) → [grade] → timezone → consent; each step renders itself (T-07). */
export function personSteps(o: PersonStepOptions): Record<string, FlowStep<PersonOnboardingData>> {
  const steps: Record<string, FlowStep<PersonOnboardingData>> = {
    name: {
      enter: async (ctx, d) => {
        const full = `${d.firstName} ${d.lastName}`.trim();
        const kb = new InlineKeyboard().text(
          ctx.t('btn-keep-name', { name: clip(full) }),
          flowCb('name', 'keep'),
        );
        await renderMenu(ctx, ctx.t(`${o.prefix}-name`, { name: escapeHtml(full) }), kb);
      },
      onCallback: async (_ctx, _d, action): Promise<FlowNext> =>
        action === 'keep' ? { goto: o.afterName } : { stay: true },
      onText: async (ctx, d, text) => {
        const [first, ...rest] = text.split(/\s+/).filter(Boolean);
        if (!first || text.length > MAX_PERSON_NAME_LENGTH) {
          await say(ctx, ctx.t('onb-name-invalid'));
          return { stay: true };
        }
        d.firstName = first;
        d.lastName = rest.join(' ');
        return { goto: o.afterName };
      },
    },
    timezone: {
      enter: async (ctx, d) => {
        const kb = new InlineKeyboard();
        COMMON_TIMEZONES.forEach((zone, i) => {
          kb.text(zone, flowCb('timezone', 'tz', zone));
          if (i % 2 === 1) kb.row();
        });
        await renderMenu(ctx, ctx.t(`${o.prefix}-timezone`, { current: d.timezone }), kb);
      },
      onCallback: async (_ctx, d, action, args) => {
        if (action === 'tz' && args[0] && isValidTimezone(args[0])) {
          d.timezone = args[0];
          return { goto: o.afterTimezone };
        }
        return { stay: true };
      },
      onText: async (ctx, d, text) => {
        if (!isValidTimezone(text)) {
          await say(ctx, ctx.t('onb-timezone-invalid'));
          return { stay: true };
        }
        d.timezone = text;
        return { goto: o.afterTimezone };
      },
    },
    consent: {
      enter: async (ctx, d) => {
        const kb = new InlineKeyboard().text(ctx.t('btn-accept-consent'), flowCb('consent', 'accept'));
        await renderMenu(
          ctx,
          ctx.t(`${o.prefix}-consent`, { version: CONSENT_VERSION, child: escapeHtml(d.childName) }),
          kb,
        );
      },
      onCallback: async (_ctx, _d, action) => (action === 'accept' ? { done: true } : { stay: true }),
      onText: async (ctx) => {
        await say(ctx, ctx.t('onb-consent-button'));
        return { stay: true };
      },
    },
  };
  if (o.afterGrade) {
    steps['grade'] = {
      enter: async (ctx, d) => {
        const kb = new InlineKeyboard().text(ctx.t('btn-skip'), flowCb('grade', 'skip'));
        await renderMenu(ctx, ctx.t(`${o.prefix}-grade`, { current: escapeHtml(d.grade || '—') }), kb);
      },
      onCallback: async (_ctx, _d, action) => (action === 'skip' ? { goto: o.afterGrade! } : { stay: true }),
      onText: async (ctx, d, text) => {
        if (text.length > MAX_GRADE_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_GRADE_LENGTH }));
          return { stay: true };
        }
        d.grade = text;
        return { goto: o.afterGrade! };
      },
    };
  }
  return steps;
}
