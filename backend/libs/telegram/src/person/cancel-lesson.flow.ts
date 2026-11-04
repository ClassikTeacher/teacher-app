import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { CancelLessonUseCase } from '@modules/schedule/cancellations/cancel-lesson.use-case.js';
import { CancelTemplatesQuery } from '@modules/schedule/cancellations/cancel-templates.query.js';
import { MAX_CANCEL_REASON_LENGTH } from '@modules/schedule/cancellations/cancel.rules.js';
import { PersonScheduleQuery } from '@modules/schedule/lessons/person-schedule.query.js';
import type { BotContext } from '../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../core/flow.js';
import { clip, fullName } from '../core/format.js';
import { escapeHtml, renderMenu, say } from '../core/ui.js';
import { resolveRef, shortRef } from '../staff-bot/common/short-ref.js';
import { cancelErrorKeyboard, explainCancelError } from './cancel-errors.js';
import { personLessonWhen, personZone } from './lesson-format.js';

export interface PersonCancelPreset {
  lessonId: string;
  /** The child, when a parent cancels (Р-25); the student's own id otherwise. */
  studentId: string;
  /** Callback payload of the «back» button (the lesson card). */
  backCb: string;
}

export interface PersonCancelData extends Record<string, unknown>, PersonCancelPreset {
  outcome: 'cancel' | 'absence';
  isLate: boolean;
  lateHours: number;
  when: string;
  who: string;
  message: string;
  templateId: string | null;
}

/**
 * UC-20 / UC-21 in StudentBot and ParentBot (5.7.3): reason (template or own text) → confirmation with the late
 * mark → done. A group lesson turns into an absence notice (CNL-03). Rules that forbid the action (CNL-02,
 * CNL-07, a started lesson) are explained before the dialog starts, with «Написать учителю».
 */
@Injectable()
export class PersonCancelLessonFlow extends Flow<PersonCancelData> {
  readonly name = 'person-cancel-lesson';
  readonly firstStep = 'reason';

  constructor(
    private readonly cancel: CancelLessonUseCase,
    private readonly templates: CancelTemplatesQuery,
    private readonly schedule: PersonScheduleQuery,
    private readonly profiles: TeacherProfileRepository,
  ) {
    super();
  }

  async initial(ctx: BotContext, arg: unknown): Promise<PersonCancelData> {
    const preset = arg as PersonCancelPreset;
    const actor = ctx.actor!.actor;
    const view = await this.schedule.lesson(actor, preset.lessonId);
    const check = await this.cancel.preview(actor, preset.lessonId, preset.studentId, this.role(ctx));
    const profile = await this.profiles.find(view.lesson.teacherId);
    return {
      ...preset,
      outcome: check.outcome,
      isLate: check.isLate,
      lateHours: profile?.lateCancelHours ?? 0,
      when: personLessonWhen(ctx, view, personZone(ctx)),
      who: fullName(view.teacher),
      message: '',
      templateId: null,
    };
  }

  /** Explains a refusal instead of starting (UC-20 alternatives); false when the dialog did not start. */
  async tryStart(ctx: BotContext, preset: PersonCancelPreset): Promise<boolean> {
    try {
      await this.start(ctx, preset);
      return true;
    } catch (error) {
      if (!AppError.is(error)) throw error;
      await this.explain(ctx, error, preset);
      return false;
    }
  }

  private async explain(ctx: BotContext, error: AppError, preset: PersonCancelPreset): Promise<void> {
    const text = explainCancelError(ctx, error);
    if (!text) throw error;
    ctx.session.flow = undefined;
    const view = await this.schedule.lesson(ctx.actor!.actor, preset.lessonId).catch(() => null);
    await renderMenu(ctx, text, cancelErrorKeyboard(ctx, view?.teacher.username ?? null, preset.backCb));
  }

  private role(ctx: BotContext): 'STUDENT' | 'PARENT' {
    return ctx.bot === 'parent' ? 'PARENT' : 'STUDENT';
  }

  private async leave(ctx: BotContext, d: PersonCancelData, text: string): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(ctx, text, new InlineKeyboard().text(ctx.t('btn-cancel-back'), d.backCb));
    return { stay: true };
  }

  readonly steps: Record<string, FlowStep<PersonCancelData>> = {
    reason: {
      enter: async (ctx, d) => {
        const options = await this.templates.forActor(ctx.actor!.actor, this.role(ctx));
        const kb = new InlineKeyboard();
        options.forEach((t, i) =>
          kb.text(clip(t.text, 40), flowCb('reason', 'pick', ...shortRef(t.text, i))).row(),
        );
        kb.text(ctx.t('btn-cancel-own-text'), flowCb('reason', 'own')).text(
          ctx.t('btn-cancel'),
          flowCb('reason', 'cancel'),
        );
        const key = d.outcome === 'absence' ? 'absence-reason-prompt' : 'cancel-reason-prompt';
        await renderMenu(ctx, ctx.t(key, { when: escapeHtml(d.when) }), kb);
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.leave(ctx, d, ctx.t('cancel-done'));
        if (action === 'own') {
          await say(ctx, ctx.t('cancel-own-text-prompt', { max: MAX_CANCEL_REASON_LENGTH }));
          return { stay: true };
        }
        if (action !== 'pick') return { stay: true };
        const options = await this.templates.forActor(ctx.actor!.actor, this.role(ctx));
        const picked = resolveRef(options, args[0], args[1], (t) => t.text);
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
        const key = d.outcome === 'absence' ? 'absence-confirm' : 'cancel-confirm';
        await renderMenu(
          ctx,
          ctx.t(key, {
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

  async complete(ctx: BotContext, d: PersonCancelData): Promise<void> {
    let outcome: 'cancel' | 'absence';
    try {
      outcome = (
        await this.cancel.execute(ctx.actor!.actor, {
          lessonId: d.lessonId,
          reason: d.message,
          templateId: d.templateId,
          studentId: d.studentId,
          as: this.role(ctx),
        })
      ).outcome;
    } catch (error) {
      if (!AppError.is(error)) throw error;
      await this.explain(ctx, error, d); // the rules changed meanwhile: repeating cannot help
      return;
    }
    const key = outcome === 'absence' ? 'absence-done' : 'cancel-lesson-done';
    await renderMenu(
      ctx,
      ctx.t(key, { when: escapeHtml(d.when) }),
      new InlineKeyboard().text(ctx.t('btn-cancel-back'), d.backCb),
    );
  }
}
