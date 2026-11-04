import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import { LessonReportUseCase, NO_SHOW_REASON } from '@modules/schedule/lessons/lesson-report.use-case.js';
import {
  MAX_COMMENT_LENGTH,
  MAX_NOT_HELD_REASON_LENGTH,
  MAX_TOPIC_LENGTH,
} from '@modules/schedule/lessons/lesson.rules.js';
import { ATTENDANCE, type Attendance } from '@modules/schedule/schema.js';
import type { BotContext, FlowState } from '../../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../../core/flow.js';
import { clip } from '../../core/format.js';
import { escapeHtml, renderMenu, say } from '../../core/ui.js';
import { isTerminalFlowError } from '../common/flow-errors.js';
import { sectionCb } from '../section-module.js';

export interface ReportParticipant {
  studentId: string;
  name: string;
}

export interface LessonReportPreset {
  lessonId: string;
  who: string;
  when: string;
  plannedTopic: string | null;
  participants: ReportParticipant[];
  /** `noshow` jumps straight to the reason step (UC-24 2а); `planned` takes the planned topic. */
  entry?: 'planned' | 'topic' | 'noshow';
}

export interface LessonReportData extends Record<string, unknown>, LessonReportPreset {
  topic: string | null;
  attendance: Record<string, Attendance>;
  comment: string | null;
}

const ATTENDANCE_KEYS: Record<Attendance, string> = {
  present: 'btn-attendance-present',
  late: 'btn-attendance-late',
  absent_notified: 'btn-attendance-absent-notified',
  absent: 'btn-attendance-absent',
};

/** UC-24: topic (planned / typed) → attendance per participant → optional comment → completed; no-show → not_held. */
@Injectable()
export class LessonReportFlow extends Flow<LessonReportData> {
  readonly name = 'lesson-report';
  readonly firstStep = 'topic';

  constructor(private readonly report: LessonReportUseCase) {
    super();
  }

  async initial(_ctx: BotContext, arg: unknown): Promise<LessonReportData> {
    const preset = arg as LessonReportPreset;
    return {
      ...preset,
      topic: preset.entry === 'planned' ? preset.plannedTopic : null,
      attendance: {},
      comment: null,
    };
  }

  override async start(ctx: BotContext, arg?: unknown): Promise<void> {
    const data = await this.initial(ctx, arg);
    const noShow = data.entry === 'noshow' && data.participants.length <= 1;
    const step = noShow ? 'reason' : data.topic ? 'attendance' : 'topic';
    const state: FlowState = { name: this.name, step, data, startedAt: Date.now() };
    ctx.session.flow = state;
    await this.steps[step]!.enter(ctx, data);
  }

  private async cancel(ctx: BotContext, d: LessonReportData): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(ctx, ctx.t('cancel-done'), this.back(ctx, d));
    return { stay: true };
  }

  private back(ctx: BotContext, d: LessonReportData): InlineKeyboard {
    return new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('today', 'lesson', d.lessonId));
  }

  private allMarked(d: LessonReportData): boolean {
    return d.participants.every((p) => d.attendance[p.studentId] !== undefined);
  }

  readonly steps: Record<string, FlowStep<LessonReportData>> = {
    topic: {
      enter: async (ctx, d) => {
        const kb = new InlineKeyboard();
        if (d.plannedTopic) kb.text(ctx.t('btn-topic-as-planned'), flowCb('topic', 'planned')).row();
        // a group lesson marks absences per participant; «не пришёл» means the whole lesson did not take place
        if (d.participants.length <= 1) kb.text(ctx.t('btn-student-no-show'), flowCb('topic', 'noshow'));
        kb.text(ctx.t('btn-cancel'), flowCb('topic', 'cancel'));
        await renderMenu(ctx, ctx.t('report-topic', { who: escapeHtml(d.who), when: d.when }), kb);
      },
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.cancel(ctx, d);
        if (action === 'noshow' && d.participants.length <= 1) return { goto: 'reason' };
        if (action === 'planned' && d.plannedTopic) {
          d.topic = d.plannedTopic;
          return { goto: 'attendance' };
        }
        return { stay: true };
      },
      onText: async (ctx, d, text) => {
        const topic = text.trim();
        if (!topic || topic.length > MAX_TOPIC_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_TOPIC_LENGTH }));
          return { stay: true };
        }
        d.topic = topic;
        return { goto: 'attendance' };
      },
    },
    attendance: {
      enter: async (ctx, d) => {
        const kb = new InlineKeyboard();
        const single = d.participants.length === 1;
        d.participants.forEach((p, i) => {
          if (single) {
            for (const a of ATTENDANCE)
              kb.text(ctx.t(ATTENDANCE_KEYS[a]), flowCb('attendance', 'set', i, a)).row();
            return;
          }
          const current = d.attendance[p.studentId];
          const mark = current ? ctx.t(`attendance-${current.replace(/_/g, '-')}`) : '—';
          kb.text(`${clip(p.name, 20)}: ${mark}`, flowCb('attendance', 'cycle', i)).row();
        });
        if (!single) kb.text(ctx.t('btn-next'), flowCb('attendance', 'next'));
        kb.text(ctx.t('btn-cancel'), flowCb('attendance', 'cancel'));
        const text = single
          ? ctx.t('report-attendance', { who: escapeHtml(d.participants[0]?.name ?? d.who) })
          : ctx.t('report-attendance-group');
        await renderMenu(ctx, text, kb);
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.cancel(ctx, d);
        const p = d.participants[Number(args[0])];
        if (action === 'set' && p && ATTENDANCE.includes(args[1] as Attendance)) {
          d.attendance = { ...d.attendance, [p.studentId]: args[1] as Attendance };
          return { goto: 'comment' };
        }
        if (action === 'cycle' && p) {
          const current = d.attendance[p.studentId];
          const next = ATTENDANCE[(current ? ATTENDANCE.indexOf(current) + 1 : 0) % ATTENDANCE.length]!;
          d.attendance = { ...d.attendance, [p.studentId]: next };
          return { goto: 'attendance' };
        }
        if (action === 'next') {
          if (!this.allMarked(d)) {
            await ctx.answerCallbackQuery({ text: ctx.t('error-validation-error') }).catch(() => undefined);
            return { stay: true };
          }
          return { goto: 'comment' };
        }
        return { stay: true };
      },
    },
    comment: {
      enter: async (ctx) =>
        renderMenu(
          ctx,
          ctx.t('report-comment'),
          new InlineKeyboard()
            .text(ctx.t('btn-skip'), flowCb('comment', 'skip'))
            .text(ctx.t('btn-cancel'), flowCb('comment', 'cancel')),
        ),
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.cancel(ctx, d);
        return action === 'skip' ? { done: true } : { stay: true };
      },
      onText: async (ctx, d, text) => {
        if (text.length > MAX_COMMENT_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_COMMENT_LENGTH }));
          return { stay: true };
        }
        d.comment = text.trim() || null;
        return { done: true };
      },
    },
    reason: {
      enter: async (ctx) =>
        renderMenu(
          ctx,
          ctx.t('report-no-show-reason'),
          new InlineKeyboard()
            .text(ctx.t('btn-no-show-reason'), flowCb('reason', 'noshow'))
            .text(ctx.t('btn-cancel'), flowCb('reason', 'cancel')),
        ),
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.cancel(ctx, d);
        if (action !== 'noshow') return { stay: true };
        return this.saveNotHeld(ctx, d, NO_SHOW_REASON);
      },
      onText: async (ctx, d, text) => {
        if (!text.trim() || text.length > MAX_NOT_HELD_REASON_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_NOT_HELD_REASON_LENGTH }));
          return { stay: true };
        }
        return this.saveNotHeld(ctx, d, text.trim());
      },
    },
  };

  private async saveNotHeld(ctx: BotContext, d: LessonReportData, reason: string): Promise<FlowNext> {
    if (!ctx.actor) return { stay: true };
    try {
      await this.report.notHeld(ctx.actor.actor, d.lessonId, reason);
    } catch (error) {
      return this.failed(ctx, d, error);
    }
    ctx.session.flow = undefined;
    await renderMenu(ctx, ctx.t('report-not-held-saved'), this.back(ctx, d));
    return { stay: true };
  }

  async complete(ctx: BotContext, d: LessonReportData): Promise<void> {
    if (!ctx.actor || !d.topic) {
      ctx.session.flow = undefined;
      return;
    }
    try {
      await this.report.complete(ctx.actor.actor, d.lessonId, {
        topic: d.topic,
        attendance: d.participants.flatMap((p) => {
          const attendance = d.attendance[p.studentId];
          return attendance ? [{ studentId: p.studentId, attendance }] : [];
        }),
        sharedComment: d.comment,
      });
    } catch (error) {
      await this.failed(ctx, d, error);
      return;
    }
    // 5.6.4 / UC-26: homework straight from the report, participants and the lesson preset
    const kb = new InlineKeyboard()
      .text(ctx.t('btn-assign-homework'), sectionCb('assignments', 'new', d.lessonId))
      .row()
      .text(ctx.t('btn-back'), sectionCb('today', 'lesson', d.lessonId));
    await renderMenu(ctx, ctx.t('report-saved'), kb);
  }

  /** Already reported or not over yet: a short explanation and the dialog ends; anything else is rethrown. */
  private async failed(ctx: BotContext, d: LessonReportData, error: unknown): Promise<FlowNext> {
    if (AppError.is(error, 'VALIDATION_ERROR') && error.details?.['reason'] === 'attendance_required') {
      // the participants changed since the dialog started: start over from the card
      ctx.session.flow = undefined;
      await renderMenu(ctx, ctx.t('report-participants-changed'), this.back(ctx, d));
      return { stay: true };
    }
    if (AppError.is(error, 'CONFLICT')) {
      ctx.session.flow = undefined;
      const key = error.details?.['reason'] === 'not_over' ? 'report-not-over' : 'report-already';
      await renderMenu(ctx, ctx.t(key), this.back(ctx, d));
      return { stay: true };
    }
    if (isTerminalFlowError(error)) ctx.session.flow = undefined;
    throw error;
  }
}
