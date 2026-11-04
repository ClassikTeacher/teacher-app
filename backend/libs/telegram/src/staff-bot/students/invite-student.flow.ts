import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { InviteStudentUseCase } from '@modules/people/links/invite-student.use-case.js';
import {
  DEFAULT_MAX_LESSONS_PER_WEEK,
  MAX_GRADE_LENGTH,
  MAX_MAX_LESSONS_PER_WEEK,
} from '@modules/people/links/link.rules.js';
import type { SubjectRow } from '@modules/people/schema.js';
import { SubjectRepository } from '@modules/people/subject.repository.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import type { BotContext } from '../../core/context.js';
import { AppError } from '@shared/errors/app-error.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../../core/flow.js';
import { paginate, renderMenu, say } from '../../core/ui.js';
import { sectionCb } from '../section-module.js';
import { sendInvitationCard } from './format.js';

export interface InviteStudentData extends Record<string, unknown> {
  subjectIds: string[];
  page: number;
  maxLessonsPerWeek: number | null;
  displayName: string;
  grade: string;
}

const LIMIT_OPTIONS: readonly number[] = [1, 2, 3, 4, 5];
const MAX_NAME = 100;

/** UC-10 steps 2–3 in StaffBot: subjects → weekly limit (PPL-06) → optional name → optional class → card with link. */
@Injectable()
export class InviteStudentFlow extends Flow<InviteStudentData> {
  readonly name = 'invite-student';
  readonly firstStep = 'subjects';

  constructor(
    private readonly invite: InviteStudentUseCase,
    private readonly subjects: SubjectRepository,
    private readonly profiles: TeacherProfileRepository,
  ) {
    super();
  }

  async initial(): Promise<InviteStudentData> {
    return {
      subjectIds: [],
      page: 1,
      maxLessonsPerWeek: DEFAULT_MAX_LESSONS_PER_WEEK,
      displayName: '',
      grade: '',
    };
  }

  /** The teacher's own subjects first; the whole catalogue when the profile has none left active. */
  private async offeredSubjects(ctx: BotContext): Promise<SubjectRow[]> {
    const active = await this.subjects.listActive();
    const profile = ctx.actor ? await this.profiles.find(ctx.actor.account.id) : null;
    const own = active.filter((s) => profile?.subjectIds.includes(s.id));
    return own.length > 0 ? own : active;
  }

  private async renderSubjects(ctx: BotContext, d: InviteStudentData): Promise<void> {
    const page = paginate(await this.offeredSubjects(ctx), d.page);
    const kb = new InlineKeyboard();
    for (const s of page.items) {
      kb.text(
        `${d.subjectIds.includes(s.id) ? '✅ ' : ''}${s.name}`,
        flowCb('subjects', 'toggle', s.id),
      ).row();
    }
    if (page.pages > 1) {
      if (page.page > 1) kb.text('◀️', flowCb('subjects', 'page', page.page - 1));
      kb.text(`${page.page}/${page.pages}`, flowCb('subjects', 'noop'));
      if (page.page < page.pages) kb.text('▶️', flowCb('subjects', 'page', page.page + 1));
      kb.row();
    }
    kb.text(ctx.t('btn-done'), flowCb('subjects', 'done')).text(
      ctx.t('btn-cancel'),
      flowCb('subjects', 'cancel'),
    );
    await renderMenu(ctx, ctx.t('invite-student-subjects', { count: d.subjectIds.length }), kb);
  }

  private async cancel(ctx: BotContext): Promise<FlowNext> {
    ctx.session.flow = undefined;
    const kb = new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('students', 'list'));
    await renderMenu(ctx, ctx.t('cancel-done'), kb);
    return { stay: true };
  }

  readonly steps: Record<string, FlowStep<InviteStudentData>> = {
    subjects: {
      enter: (ctx, d) => this.renderSubjects(ctx, d),
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.cancel(ctx);
        if (action === 'toggle' && args[0]) {
          const id = args[0];
          if (!(await this.offeredSubjects(ctx)).some((s) => s.id === id)) return { stay: true };
          d.subjectIds = d.subjectIds.includes(id)
            ? d.subjectIds.filter((x) => x !== id)
            : [...d.subjectIds, id];
        } else if (action === 'page' && args[0]) {
          const page = Number(args[0]);
          d.page = Number.isInteger(page) && page > 0 ? page : 1;
        } else if (action === 'done') {
          if (d.subjectIds.length === 0) {
            await ctx.answerCallbackQuery({ text: ctx.t('onb-subjects-required') }).catch(() => undefined);
            return { stay: true };
          }
          return { goto: 'limit' };
        }
        await this.renderSubjects(ctx, d);
        return { stay: true };
      },
    },
    limit: {
      enter: async (ctx) => {
        const kb = new InlineKeyboard();
        for (const n of LIMIT_OPTIONS) kb.text(String(n), flowCb('limit', 'set', n));
        kb.row()
          .text(ctx.t('limit-none'), flowCb('limit', 'none'))
          .text(ctx.t('btn-cancel'), flowCb('limit', 'cancel'));
        await renderMenu(ctx, ctx.t('invite-student-limit', { default: DEFAULT_MAX_LESSONS_PER_WEEK }), kb);
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.cancel(ctx);
        if (action === 'none') {
          d.maxLessonsPerWeek = null;
          return { goto: 'name' };
        }
        const n = Number(args[0]);
        if (action !== 'set' || !LIMIT_OPTIONS.includes(n)) return { stay: true };
        d.maxLessonsPerWeek = n;
        return { goto: 'name' };
      },
      onText: async (ctx, d, text) => {
        const n = /^\d{1,2}$/.test(text) ? Number(text) : NaN;
        if (!Number.isInteger(n) || n < 1 || n > MAX_MAX_LESSONS_PER_WEEK) {
          await say(ctx, ctx.t('invite-student-limit-invalid', { max: MAX_MAX_LESSONS_PER_WEEK }));
          return { stay: true };
        }
        d.maxLessonsPerWeek = n;
        return { goto: 'name' };
      },
    },
    name: {
      enter: async (ctx) => {
        const kb = new InlineKeyboard()
          .text(ctx.t('btn-skip'), flowCb('name', 'skip'))
          .text(ctx.t('btn-cancel'), flowCb('name', 'cancel'));
        await renderMenu(ctx, ctx.t('invite-student-name'), kb);
      },
      onCallback: async (ctx, _d, action) => {
        if (action === 'cancel') return this.cancel(ctx);
        return action === 'skip' ? { goto: 'grade' } : { stay: true };
      },
      onText: async (ctx, d, text) => {
        if (text.length > MAX_NAME) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_NAME }));
          return { stay: true };
        }
        d.displayName = text;
        return { goto: 'grade' };
      },
    },
    grade: {
      enter: async (ctx) => {
        const kb = new InlineKeyboard()
          .text(ctx.t('btn-skip'), flowCb('grade', 'skip'))
          .text(ctx.t('btn-cancel'), flowCb('grade', 'cancel'));
        await renderMenu(ctx, ctx.t('invite-student-grade'), kb);
      },
      onCallback: async (ctx, _d, action) => {
        if (action === 'cancel') return this.cancel(ctx);
        return action === 'skip' ? { done: true } : { stay: true };
      },
      onText: async (ctx, d, text) => {
        if (text.length > MAX_GRADE_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_GRADE_LENGTH }));
          return { stay: true };
        }
        d.grade = text;
        return { done: true };
      },
    },
  };

  async complete(ctx: BotContext, d: InviteStudentData): Promise<void> {
    if (!ctx.actor) return;
    let result;
    try {
      result = await this.invite.execute(ctx.actor.actor, {
        subjectIds: d.subjectIds,
        maxLessonsPerWeek: d.maxLessonsPerWeek,
        displayName: d.displayName || null,
        grade: d.grade || null,
      });
    } catch (error) {
      // a full roster (UC-10 3а) cannot be fixed by retyping the class: leave the dialog, offer the list
      if (AppError.is(error, 'LIMIT_EXCEEDED') || AppError.is(error, 'FEATURE_DISABLED'))
        ctx.session.flow = undefined;
      throw error;
    }
    const subjects = await this.subjects.findByIds(result.link.subjectIds);
    await sendInvitationCard(ctx, result.link, result.issued, subjects);
  }
}
