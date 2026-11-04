import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { DateTime } from 'luxon';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { OpenSlotsQuery } from '@modules/schedule/availability/open-slots.query.js';
import { PersonScheduleQuery } from '@modules/schedule/lessons/person-schedule.query.js';
import { MAX_RESCHEDULE_COMMENT_LENGTH } from '@modules/schedule/reschedule/reschedule-lesson.use-case.js';
import { RescheduleRequestUseCase } from '@modules/schedule/reschedule/reschedule-request.use-case.js';
import type { BotContext } from '../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../core/flow.js';
import { fullName } from '../core/format.js';
import { escapeHtml, renderMenu, say } from '../core/ui.js';
import { dayPickerKeyboard } from '../staff-bot/schedule/day-picker.js';
import { fmtDay, fmtTime, isIsoDay, parseDayInput, dayRange } from '../staff-bot/schedule/time-input.js';
import { cancelErrorKeyboard, explainCancelError } from './cancel-errors.js';
import { personLessonWhen, personZone } from './lesson-format.js';

const SLOT_BUTTONS = 16;

export interface RescheduleRequestPreset {
  lessonId: string;
  /** The child for a parent (Р-25), the student's own id otherwise. */
  studentId: string;
  backCb: string;
}

export interface RescheduleRequestData extends Record<string, unknown>, RescheduleRequestPreset {
  mode: 'request' | 'ask';
  teacherId: string;
  teacher: string;
  from: string;
  durationMin: number;
  dateIso: string;
  startsAt: string | null;
  reason: string;
}

/**
 * UC-19 (5.7.4) in StudentBot and ParentBot. Open calendar: day → open slot → reason → confirm → a request the
 * teacher decides (Р-24; the old lesson stays, nothing is held). Closed calendar: reason → a plea to the teacher.
 */
@Injectable()
export class RescheduleRequestFlow extends Flow<RescheduleRequestData> {
  readonly name = 'reschedule-request';
  readonly firstStep = 'day';

  constructor(
    private readonly requests: RescheduleRequestUseCase,
    private readonly schedule: PersonScheduleQuery,
    private readonly openSlots: OpenSlotsQuery,
    private readonly clock: Clock,
  ) {
    super();
  }

  async initial(ctx: BotContext, arg: unknown): Promise<RescheduleRequestData> {
    const preset = arg as RescheduleRequestPreset;
    const actor = ctx.actor!.actor;
    const view = await this.schedule.lesson(actor, preset.lessonId);
    const childId = ctx.bot === 'parent' ? preset.studentId : undefined;
    const mode = await this.requests.mode(actor, preset.lessonId, childId);
    return {
      ...preset,
      mode,
      teacherId: view.teacher.id,
      teacher: fullName(view.teacher),
      from: personLessonWhen(ctx, view, personZone(ctx)),
      durationMin: Math.round((view.lesson.endsAt.getTime() - view.lesson.startsAt.getTime()) / 60_000),
      dateIso: '',
      startsAt: null,
      reason: '',
    };
  }

  /** Starts at the right step; refusals (a started lesson, no active link) are explained instead. */
  async tryStart(ctx: BotContext, preset: RescheduleRequestPreset): Promise<boolean> {
    try {
      const data = await this.initial(ctx, preset);
      const step = data.mode === 'request' ? 'day' : 'reason';
      ctx.session.flow = { name: this.name, step, data, startedAt: Date.now() };
      await this.steps[step]!.enter(ctx, data);
      return true;
    } catch (error) {
      if (!AppError.is(error)) throw error;
      const text = explainCancelError(ctx, error);
      if (!text) throw error;
      const view = await this.schedule.lesson(ctx.actor!.actor, preset.lessonId).catch(() => null);
      await renderMenu(ctx, text, cancelErrorKeyboard(ctx, view?.teacher.username ?? null, preset.backCb));
      return false;
    }
  }

  private childId(ctx: BotContext, d: RescheduleRequestData): string | undefined {
    return ctx.bot === 'parent' ? d.studentId : undefined;
  }

  private async leave(ctx: BotContext, d: RescheduleRequestData, text: string): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(ctx, text, new InlineKeyboard().text(ctx.t('btn-cancel-back'), d.backCb));
    return { stay: true };
  }

  /** Open slots of the chosen day for the student (the parent asks on the child's behalf). */
  private async daySlots(ctx: BotContext, d: RescheduleRequestData): Promise<Date[]> {
    const student = {
      accountId: d.studentId,
      roles: ['STUDENT' as const],
      status: 'active' as const,
      source: 'bot' as const,
    };
    const zone = personZone(ctx);
    try {
      const { slots } = await this.openSlots.slots(student, {
        teacherId: d.teacherId,
        range: dayRange(d.dateIso, zone),
        durationMin: d.durationMin,
        excludeLessonId: d.lessonId, // a shift inside the lesson's own time is allowed (M-2)
      });
      return slots.map((s) => s.start);
    } catch (error) {
      if (AppError.is(error, 'VALIDATION_ERROR')) return []; // the lesson's duration is not offered for booking
      throw error;
    }
  }

  readonly steps: Record<string, FlowStep<RescheduleRequestData>> = {
    day: {
      enter: async (ctx, d) => {
        const kb = dayPickerKeyboard(ctx, personZone(ctx), this.clock.now(), (iso) =>
          flowCb('day', 'pick', iso),
        );
        kb.text(ctx.t('btn-cancel'), flowCb('day', 'cancel'));
        await renderMenu(
          ctx,
          ctx.t('request-day-prompt', { when: escapeHtml(d.from), teacher: escapeHtml(d.teacher) }),
          kb,
        );
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.leave(ctx, d, ctx.t('cancel-done'));
        if (action === 'pick' && isIsoDay(args[0])) {
          d.dateIso = args[0];
          return { goto: 'slot' };
        }
        return { stay: true };
      },
      onText: async (ctx, d, text) => {
        const iso = parseDayInput(text, personZone(ctx), this.clock.now());
        if (!iso) {
          await say(ctx, ctx.t('day-invalid'));
          return { stay: true };
        }
        d.dateIso = iso;
        return { goto: 'slot' };
      },
    },
    slot: {
      enter: async (ctx, d) => {
        const zone = personZone(ctx);
        const slots = await this.daySlots(ctx, d);
        const kb = new InlineKeyboard();
        slots.slice(0, SLOT_BUTTONS).forEach((start, i) => {
          const local = DateTime.fromJSDate(start, { zone });
          kb.text(fmtTime(start, zone), flowCb('slot', 'at', local.hour * 60 + local.minute));
          if (i % 4 === 3) kb.row();
        });
        if (slots.length % 4 !== 0 || slots.length === 0) kb.row();
        kb.text(ctx.t('btn-back'), flowCb('slot', 'back')).text(
          ctx.t('btn-cancel'),
          flowCb('slot', 'cancel'),
        );
        await renderMenu(
          ctx,
          ctx.t(slots.length > 0 ? 'request-slot-prompt' : 'request-slot-none', {
            day: fmtDay(d.dateIso, zone),
          }),
          kb,
        );
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.leave(ctx, d, ctx.t('cancel-done'));
        if (action === 'back') return { goto: 'day' };
        if (action !== 'at') return { stay: true };
        const zone = personZone(ctx);
        const minutes = Number(args[0]);
        const picked = (await this.daySlots(ctx, d)).find((s) => {
          const local = DateTime.fromJSDate(s, { zone });
          return local.hour * 60 + local.minute === minutes;
        });
        if (!picked) return { stay: true }; // the slot vanished: the keyboard is re-rendered on the next entry
        d.startsAt = picked.toISOString();
        return { goto: 'reason' };
      },
    },
    reason: {
      enter: async (ctx, d) => {
        const key = d.mode === 'request' ? 'request-reason-prompt' : 'ask-reason-prompt';
        const kb = new InlineKeyboard().text(ctx.t('btn-cancel'), flowCb('reason', 'cancel'));
        await renderMenu(ctx, ctx.t(key, { when: escapeHtml(d.from), teacher: escapeHtml(d.teacher) }), kb);
      },
      onCallback: async (ctx, d, action) =>
        action === 'cancel' ? this.leave(ctx, d, ctx.t('cancel-done')) : { stay: true },
      onText: async (ctx, d, text) => {
        const clean = text.trim();
        if (!clean || clean.length > MAX_RESCHEDULE_COMMENT_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_RESCHEDULE_COMMENT_LENGTH }));
          return { stay: true };
        }
        d.reason = clean;
        return d.mode === 'request' ? { goto: 'confirm' } : { done: true };
      },
    },
    confirm: {
      enter: async (ctx, d) => {
        const zone = personZone(ctx);
        const to = d.startsAt ? new Date(d.startsAt) : null;
        const kb = new InlineKeyboard()
          .text(ctx.t('btn-request-send'), flowCb('confirm', 'ok'))
          .text(ctx.t('btn-cancel'), flowCb('confirm', 'cancel'));
        await renderMenu(
          ctx,
          ctx.t('request-confirm', {
            teacher: escapeHtml(d.teacher),
            from: escapeHtml(d.from),
            to: to ? DateTime.fromJSDate(to, { zone }).setLocale('ru').toFormat('cccc dd.MM HH:mm') : '—',
            reason: escapeHtml(d.reason),
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

  async complete(ctx: BotContext, d: RescheduleRequestData): Promise<void> {
    const actor = ctx.actor!.actor;
    try {
      if (d.mode === 'request')
        await this.requests.request(actor, {
          lessonId: d.lessonId,
          startsAt: new Date(d.startsAt!),
          reason: d.reason,
          studentId: this.childId(ctx, d),
        });
      else
        await this.requests.ask(actor, {
          lessonId: d.lessonId,
          reason: d.reason,
          studentId: this.childId(ctx, d),
        });
    } catch (error) {
      if (AppError.is(error, 'CONFLICT') && error.details?.['reason'] === 'pending_exists') {
        ctx.session.flow = undefined;
        await renderMenu(
          ctx,
          ctx.t('request-pending-exists'),
          new InlineKeyboard().text(ctx.t('btn-cancel-back'), d.backCb),
        );
        return;
      }
      if (AppError.is(error, 'VALIDATION_ERROR') && error.details?.['reason'] === 'not_open') {
        await say(ctx, ctx.t('request-slot-none', { day: fmtDay(d.dateIso, personZone(ctx)) }));
        ctx.session.flow!.step = 'day';
        await this.steps['day']!.enter(ctx, d);
        return;
      }
      if (AppError.is(error) && explainCancelError(ctx, error)) ctx.session.flow = undefined;
      throw error;
    }
    const key = d.mode === 'request' ? 'request-sent' : 'ask-sent';
    await renderMenu(
      ctx,
      ctx.t(key, { from: escapeHtml(d.from), when: escapeHtml(d.from) }),
      new InlineKeyboard().text(ctx.t('btn-cancel-back'), d.backCb),
    );
  }
}
