import { InlineKeyboard } from 'grammy';
import type { SubjectRepository } from '@modules/people/subject.repository.js';
import {
  LESSON_DURATION_OPTIONS,
  MAX_LESSON_DURATION_MIN,
  MIN_LESSON_DURATION_MIN,
} from '@modules/people/teacher-profile.defaults.js';
import type { BotContext } from '../core/context.js';
import { flowCb, type FlowStep } from '../core/flow.js';
import { escapeHtml, paginate, renderMenu, say } from '../core/ui.js';
import type { OnboardingData } from './onboarding.flow.js';

const MAX_NOTICE_LENGTH = 500;
const INTEGER = /^\d{1,3}$/;

const validDuration = (value: number): boolean =>
  Number.isInteger(value) && value >= MIN_LESSON_DURATION_MIN && value <= MAX_LESSON_DURATION_MIN;

/** Teacher-only questionnaire steps: subjects (multi-select), default duration, default notice text. */
export function teacherSteps(subjects: SubjectRepository): Record<string, FlowStep<OnboardingData>> {
  const renderSubjects = async (ctx: BotContext, d: OnboardingData): Promise<void> => {
    const page = paginate(await subjects.listActive(), d.subjectsPage);
    const kb = new InlineKeyboard();
    for (const s of page.items) {
      const mark = d.subjectIds.includes(s.id) ? '✅ ' : '';
      kb.text(`${mark}${s.name}`, flowCb('subjects', 'toggle', s.id)).row();
    }
    if (page.pages > 1) {
      if (page.page > 1) kb.text('◀️', flowCb('subjects', 'page', page.page - 1));
      kb.text(`${page.page}/${page.pages}`, flowCb('subjects', 'noop'));
      if (page.page < page.pages) kb.text('▶️', flowCb('subjects', 'page', page.page + 1));
      kb.row();
    }
    kb.text(ctx.t('btn-done'), flowCb('subjects', 'done'));
    await renderMenu(ctx, ctx.t('onb-subjects', { count: d.subjectIds.length }), kb);
  };

  return {
    subjects: {
      enter: renderSubjects,
      onCallback: async (ctx, d, action, args) => {
        if (action === 'toggle' && args[0]) {
          const id = args[0];
          const known = (await subjects.listActive()).some((s) => s.id === id);
          if (!known) return { stay: true };
          d.subjectIds = d.subjectIds.includes(id)
            ? d.subjectIds.filter((x) => x !== id)
            : [...d.subjectIds, id];
        } else if (action === 'page' && args[0]) {
          const page = Number(args[0]);
          d.subjectsPage = Number.isInteger(page) && page > 0 ? page : 1;
        } else if (action === 'done') {
          // a subject hidden by an admin mid-dialog must not slip through (M1-08 review)
          const active = new Set((await subjects.listActive()).map((s) => s.id));
          d.subjectIds = d.subjectIds.filter((id) => active.has(id));
          if (d.subjectIds.length === 0) {
            await ctx.answerCallbackQuery({ text: ctx.t('onb-subjects-required') }).catch(() => undefined);
            return { stay: true };
          }
          return { goto: 'timezone' };
        }
        await renderSubjects(ctx, d);
        return { stay: true };
      },
    },
    duration: {
      enter: async (ctx, d) => {
        const kb = new InlineKeyboard();
        for (const min of LESSON_DURATION_OPTIONS) kb.text(`${min}`, flowCb('duration', 'dur', min));
        await renderMenu(ctx, ctx.t('onb-duration', { current: d.durationMin }), kb);
      },
      onCallback: async (_ctx, d, action, args) => {
        const value = Number(args[0]);
        if (action !== 'dur' || !validDuration(value)) return { stay: true };
        d.durationMin = value;
        return { goto: 'notice' };
      },
      onText: async (ctx, d, text) => {
        const value = INTEGER.test(text) ? Number(text) : NaN;
        if (!validDuration(value)) {
          await say(ctx, ctx.t('onb-duration-invalid'));
          return { stay: true };
        }
        d.durationMin = value;
        return { goto: 'notice' };
      },
    },
    notice: {
      enter: async (ctx, d) => {
        const kb = new InlineKeyboard().text(ctx.t('btn-keep-notice'), flowCb('notice', 'keep'));
        await renderMenu(ctx, ctx.t('onb-notice', { current: escapeHtml(d.noticeText) }), kb);
      },
      onCallback: async (_ctx, _d, action) => (action === 'keep' ? { goto: 'consent' } : { stay: true }),
      onText: async (ctx, d, text) => {
        if (text.length === 0 || text.length > MAX_NOTICE_LENGTH) {
          await say(ctx, ctx.t('onb-notice-invalid', { max: MAX_NOTICE_LENGTH }));
          return { stay: true };
        }
        d.noticeText = text;
        return { goto: 'consent' };
      },
    },
  };
}
