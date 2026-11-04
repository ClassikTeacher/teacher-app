import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { DateTime } from 'luxon';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { LessonSlotsQuery } from '@modules/schedule/lessons/lesson-slots.query.js';
import { LessonsQuery } from '@modules/schedule/lessons/lessons.query.js';
import {
  MAX_RESCHEDULE_COMMENT_LENGTH,
  RescheduleLessonUseCase,
} from '@modules/schedule/reschedule/reschedule-lesson.use-case.js';
import type { BotContext } from '../../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../../core/flow.js';
import { escapeHtml, renderMenu, say } from '../../core/ui.js';
import { isTerminalFlowError } from '../common/flow-errors.js';
import { sectionCb } from '../section-module.js';
import { dayPickerKeyboard, zoneOf } from './day-picker.js';
import { lessonWho } from './lesson-format.js';
import {
  fmtDay,
  fmtDayOf,
  fmtTime,
  isIsoDay,
  MINUTES_PER_DAY,
  parseDayInput,
  parseTimeInput,
  toInstant,
} from './time-input.js';

const SLOT_BUTTONS = 16;

export interface RescheduleData extends Record<string, unknown> {
  lessonId: string;
  who: string;
  from: string;
  durationMin: number;
  studentIds: string[];
  dateIso: string;
  startMin: number;
  comment: string;
}

/**
 * UC-18 (5.7.4): the teacher moves a lesson — day → time (free slots with the participants' busy time, or typed)
 * → optional comment (the default notice text otherwise, Р-8) → confirm. A conflict names the busy party and
 * re-offers the day (CAL-06).
 */
@Injectable()
export class RescheduleLessonFlow extends Flow<RescheduleData> {
  readonly name = 'reschedule-lesson';
  readonly firstStep = 'day';

  constructor(
    private readonly reschedule: RescheduleLessonUseCase,
    private readonly lessons: LessonsQuery,
    private readonly slots: LessonSlotsQuery,
    private readonly profiles: TeacherProfileRepository,
    private readonly clock: Clock,
  ) {
    super();
  }

  async initial(ctx: BotContext, arg: unknown): Promise<RescheduleData> {
    const { lessonId } = arg as { lessonId: string };
    const view = await this.lessons.teacherLesson(ctx.actor!.account.id, lessonId);
    if (view.lesson.status !== 'scheduled')
      throw new AppError('CONFLICT', 'Lesson is not scheduled any more', { status: view.lesson.status });
    const zone = zoneOf(ctx);
    return {
      lessonId,
      who: lessonWho(ctx, view),
      from: `${fmtDayOf(view.lesson.startsAt, zone)} ${fmtTime(view.lesson.startsAt, zone)}`,
      durationMin: Math.round((view.lesson.endsAt.getTime() - view.lesson.startsAt.getTime()) / 60_000),
      studentIds: view.participants.map((p) => p.student.id),
      dateIso: '',
      startMin: -1,
      comment: '',
    };
  }

  private back(ctx: BotContext, d: RescheduleData): InlineKeyboard {
    return new InlineKeyboard().text(ctx.t('btn-cancel-back'), sectionCb('today', 'lesson', d.lessonId));
  }

  private async leave(ctx: BotContext, d: RescheduleData, text: string): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(ctx, text, this.back(ctx, d));
    return { stay: true };
  }

  private newStart(ctx: BotContext, d: RescheduleData): Date | null {
    return toInstant(d.dateIso, d.startMin, zoneOf(ctx));
  }

  private async renderTime(ctx: BotContext, d: RescheduleData): Promise<void> {
    const zone = zoneOf(ctx);
    const teacherId = ctx.actor!.account.id;
    const profile = await this.profiles.find(teacherId);
    const slots = await this.slots.teacherSlots({
      teacherId,
      studentIds: d.studentIds,
      dateIso: d.dateIso,
      zone,
      durationMin: d.durationMin,
      bufferBeforeMin: profile?.bufferBeforeMin ?? 0,
      bufferAfterMin: profile?.bufferAfterMin ?? 0,
      notBefore: this.clock.now(),
      excludeLessonId: d.lessonId,
    });
    const kb = new InlineKeyboard();
    slots.slice(0, SLOT_BUTTONS).forEach((slot, i) => {
      const local = DateTime.fromJSDate(slot.start, { zone });
      kb.text(fmtTime(slot.start, zone), flowCb('time', 'at', local.hour * 60 + local.minute));
      if (i % 4 === 3) kb.row();
    });
    if (slots.length % 4 !== 0 || slots.length === 0) kb.row();
    kb.text(ctx.t('btn-cancel'), flowCb('time', 'cancel'));
    await renderMenu(
      ctx,
      ctx.t(slots.length > 0 ? 'move-time-prompt' : 'move-time-no-slots', {
        day: fmtDay(d.dateIso, zone),
        duration: d.durationMin,
      }),
      kb,
    );
  }

  readonly steps: Record<string, FlowStep<RescheduleData>> = {
    day: {
      enter: async (ctx, d) => {
        const kb = dayPickerKeyboard(ctx, zoneOf(ctx), this.clock.now(), (iso) => flowCb('day', 'pick', iso));
        kb.text(ctx.t('btn-cancel'), flowCb('day', 'cancel'));
        await renderMenu(
          ctx,
          ctx.t('move-day-prompt', { when: escapeHtml(d.from), who: escapeHtml(d.who) }),
          kb,
        );
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.leave(ctx, d, ctx.t('cancel-done'));
        if (action === 'pick' && isIsoDay(args[0])) {
          d.dateIso = args[0];
          return { goto: 'time' };
        }
        return { stay: true };
      },
      onText: async (ctx, d, text) => {
        const iso = parseDayInput(text, zoneOf(ctx), this.clock.now());
        if (!iso) {
          await say(ctx, ctx.t('day-invalid'));
          return { stay: true };
        }
        d.dateIso = iso;
        return { goto: 'time' };
      },
    },
    time: {
      enter: (ctx, d) => this.renderTime(ctx, d),
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.leave(ctx, d, ctx.t('cancel-done'));
        const minutes = action === 'at' && /^\d{1,4}$/.test(args[0] ?? '') ? Number(args[0]) : NaN;
        if (!Number.isInteger(minutes) || minutes < 0 || minutes >= MINUTES_PER_DAY) return { stay: true };
        d.startMin = minutes;
        return { goto: 'comment' };
      },
      onText: async (ctx, d, text) => {
        const minutes = parseTimeInput(text);
        if (minutes === null) {
          await say(ctx, ctx.t('time-invalid'));
          return { stay: true };
        }
        d.startMin = minutes;
        return { goto: 'comment' };
      },
    },
    comment: {
      enter: async (ctx) => {
        const kb = new InlineKeyboard()
          .text(ctx.t('btn-move-no-comment'), flowCb('comment', 'skip'))
          .row()
          .text(ctx.t('btn-cancel'), flowCb('comment', 'cancel'));
        await renderMenu(ctx, ctx.t('move-comment-prompt'), kb);
      },
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.leave(ctx, d, ctx.t('cancel-done'));
        if (action !== 'skip') return { stay: true };
        d.comment = '';
        return { goto: 'confirm' };
      },
      onText: async (ctx, d, text) => {
        const clean = text.trim();
        if (clean.length > MAX_RESCHEDULE_COMMENT_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_RESCHEDULE_COMMENT_LENGTH }));
          return { stay: true };
        }
        d.comment = clean;
        return { goto: 'confirm' };
      },
    },
    confirm: {
      enter: async (ctx, d) => {
        const zone = zoneOf(ctx);
        const start = this.newStart(ctx, d);
        const profile = await this.profiles.find(ctx.actor!.account.id);
        const kb = new InlineKeyboard()
          .text(ctx.t('btn-move-confirm'), flowCb('confirm', 'ok'))
          .text(ctx.t('btn-cancel'), flowCb('confirm', 'cancel'));
        await renderMenu(
          ctx,
          ctx.t('move-confirm', {
            who: escapeHtml(d.who),
            from: escapeHtml(d.from),
            to: start ? `${fmtDayOf(start, zone)} ${fmtTime(start, zone)}` : '—',
            comment: escapeHtml(d.comment || profile?.defaultNoticeText || ''),
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

  async complete(ctx: BotContext, d: RescheduleData): Promise<void | { goto: string }> {
    const zone = zoneOf(ctx);
    const startsAt = this.newStart(ctx, d);
    if (!startsAt) return { goto: 'day' };
    try {
      await this.reschedule.execute(ctx.actor!.actor, {
        lessonId: d.lessonId,
        startsAt,
        durationMin: d.durationMin,
        comment: d.comment || null,
      });
    } catch (error) {
      if (AppError.is(error, 'LESSON_CONFLICT')) {
        const who = error.details?.['who'];
        await say(ctx, ctx.t('move-conflict', { who: typeof who === 'string' ? who : 'other' }));
        return { goto: 'time' }; // the day's free slots again
      }
      if (AppError.is(error, 'VALIDATION_ERROR') && error.details?.['reason'] === 'same_time') {
        await say(ctx, ctx.t('move-same-time'));
        return { goto: 'time' };
      }
      if (isTerminalFlowError(error)) ctx.session.flow = undefined;
      throw error;
    }
    await renderMenu(
      ctx,
      ctx.t('move-done', { to: `${fmtDayOf(startsAt, zone)} ${fmtTime(startsAt, zone)}` }),
      this.back(ctx, d),
    );
  }
}
