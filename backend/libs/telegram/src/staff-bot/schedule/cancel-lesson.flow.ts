import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { CancelLessonUseCase } from '@modules/schedule/cancellations/cancel-lesson.use-case.js';
import { CancelTemplatesQuery } from '@modules/schedule/cancellations/cancel-templates.query.js';
import { MAX_CANCEL_REASON_LENGTH } from '@modules/schedule/cancellations/cancel.rules.js';
import { LessonsQuery } from '@modules/schedule/lessons/lessons.query.js';
import type { BotContext } from '../../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../../core/flow.js';
import { clip } from '../../core/format.js';
import { escapeHtml, renderMenu, say } from '../../core/ui.js';
import { isTerminalFlowError } from '../common/flow-errors.js';
import { resolveRef, shortRef } from '../common/short-ref.js';
import { sectionCb } from '../section-module.js';
import { zoneOf } from './day-picker.js';
import { lessonWho } from './lesson-format.js';
import { fmtDayOf, fmtTime } from './time-input.js';

export interface TeacherCancelData extends Record<string, unknown> {
  lessonId: string;
  when: string;
  who: string;
  defaultText: string;
  isLate: boolean;
  lateHours: number;
  message: string;
  templateId: string | null;
}

/**
 * UC-20 by the teacher (5.7.3, Р-23): the default notice text is preselected — «Отправить текст по умолчанию»,
 * a template or own text → confirmation with the late mark → cancelled. Allowed until the lesson ends (CNL-02).
 */
@Injectable()
export class TeacherCancelLessonFlow extends Flow<TeacherCancelData> {
  readonly name = 'teacher-cancel-lesson';
  readonly firstStep = 'reason';

  constructor(
    private readonly cancel: CancelLessonUseCase,
    private readonly templates: CancelTemplatesQuery,
    private readonly lessons: LessonsQuery,
    private readonly profiles: TeacherProfileRepository,
  ) {
    super();
  }

  async initial(ctx: BotContext, arg: unknown): Promise<TeacherCancelData> {
    const { lessonId } = arg as { lessonId: string };
    const actor = ctx.actor!.actor;
    const view = await this.lessons.teacherLesson(actor.accountId, lessonId);
    const check = await this.cancel.preview(actor, lessonId, undefined, 'TEACHER'); // CONFLICT once over
    const [options, profile] = await Promise.all([
      this.templates.forActor(actor, 'TEACHER'),
      this.profiles.find(actor.accountId),
    ]);
    const zone = zoneOf(ctx);
    return {
      lessonId,
      when: `${fmtDayOf(view.lesson.startsAt, zone)} ${fmtTime(view.lesson.startsAt, zone)}`,
      who: lessonWho(ctx, view),
      defaultText: options.find((t) => t.isDefault)?.text ?? '',
      isLate: check.isLate,
      lateHours: profile?.lateCancelHours ?? 0,
      message: '',
      templateId: null,
    };
  }

  private back(ctx: BotContext, d: TeacherCancelData): InlineKeyboard {
    return new InlineKeyboard().text(ctx.t('btn-cancel-back'), sectionCb('today', 'lesson', d.lessonId));
  }

  private async leave(ctx: BotContext, d: TeacherCancelData, text: string): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(ctx, text, this.back(ctx, d));
    return { stay: true };
  }

  private async options(ctx: BotContext) {
    return (await this.templates.forActor(ctx.actor!.actor, 'TEACHER')).filter((t) => !t.isDefault);
  }

  readonly steps: Record<string, FlowStep<TeacherCancelData>> = {
    reason: {
      enter: async (ctx, d) => {
        const options = await this.options(ctx);
        const kb = new InlineKeyboard();
        if (d.defaultText) kb.text(ctx.t('btn-cancel-send-default'), flowCb('reason', 'default')).row();
        options.forEach((t, i) =>
          kb.text(clip(t.text, 40), flowCb('reason', 'pick', ...shortRef(t.text, i))).row(),
        );
        kb.text(ctx.t('btn-cancel-own-text'), flowCb('reason', 'own')).text(
          ctx.t('btn-cancel'),
          flowCb('reason', 'cancel'),
        );
        await renderMenu(
          ctx,
          ctx.t('cancel-reason-prompt-teacher', {
            when: escapeHtml(d.when),
            who: escapeHtml(d.who),
            default: escapeHtml(d.defaultText || '—'),
          }),
          kb,
        );
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.leave(ctx, d, ctx.t('cancel-done'));
        if (action === 'own') {
          await say(ctx, ctx.t('cancel-own-text-prompt', { max: MAX_CANCEL_REASON_LENGTH }));
          return { stay: true };
        }
        if (action === 'default' && d.defaultText) {
          d.message = d.defaultText;
          d.templateId = null;
          return { goto: 'confirm' };
        }
        if (action !== 'pick') return { stay: true };
        const picked = resolveRef(await this.options(ctx), args[0], args[1], (t) => t.text);
        if (!picked) return { stay: true };
        d.message = picked.text;
        d.templateId = picked.id;
        return { goto: 'confirm' };
      },
      onText: async (ctx, d, text) => {
        const clean = text.trim();
        if (!clean || clean.length > MAX_CANCEL_REASON_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_CANCEL_REASON_LENGTH }));
          return { stay: true };
        }
        d.message = clean;
        d.templateId = null;
        return { goto: 'confirm' };
      },
    },
    confirm: {
      enter: async (ctx, d) => {
        const kb = new InlineKeyboard()
          .text(ctx.t('btn-cancel-confirm'), flowCb('confirm', 'ok'))
          .text(ctx.t('btn-cancel'), flowCb('confirm', 'cancel'));
        await renderMenu(
          ctx,
          ctx.t('cancel-confirm', {
            when: escapeHtml(d.when),
            who: escapeHtml(d.who),
            message: escapeHtml(d.message),
            late: d.isLate ? ctx.t('cancel-late-note', { hours: d.lateHours }) : '',
          }),
          kb,
        );
      },
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.leave(ctx, d, ctx.t('cancel-done'));
        return action === 'ok' ? { done: true } : { stay: true };
      },
    },
  };

  async complete(ctx: BotContext, d: TeacherCancelData): Promise<void> {
    try {
      await this.cancel.execute(ctx.actor!.actor, {
        lessonId: d.lessonId,
        reason: d.message,
        templateId: d.templateId,
        as: 'TEACHER',
      });
    } catch (error) {
      if (isTerminalFlowError(error) || AppError.is(error, 'CANCEL_REASON_REQUIRED'))
        ctx.session.flow = undefined;
      throw error;
    }
    await renderMenu(ctx, ctx.t('cancel-lesson-done', { when: escapeHtml(d.when) }), this.back(ctx, d));
  }
}
