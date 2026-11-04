import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { DateTime } from 'luxon';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { LESSON_DURATION_OPTIONS } from '@modules/people/teacher-profile.defaults.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { CreateLessonUseCase, type LessonTarget } from '@modules/schedule/lessons/create-lesson.use-case.js';
import { LessonSlotsQuery } from '@modules/schedule/lessons/lesson-slots.query.js';
import { type LessonTargetItem, LessonsQuery } from '@modules/schedule/lessons/lessons.query.js';
import type { BotContext, FlowState } from '../../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../../core/flow.js';
import { clip } from '../../core/format.js';
import { escapeHtml, paginate, renderMenu, say } from '../../core/ui.js';
import { isTerminalFlowError } from '../common/flow-errors.js';
import { resolveRef, shortRef } from '../common/short-ref.js';
import { sectionCb } from '../section-module.js';
import { dayPickerKeyboard, zoneOf } from './day-picker.js';
import {
  fmtDay,
  fmtTime,
  isIsoDay,
  MINUTES_PER_DAY,
  minutesLabel,
  parseDayInput,
  parseTimeInput,
  toInstant,
} from './time-input.js';

export interface CreateLessonData extends Record<string, unknown> {
  target: LessonTarget | null;
  label: string;
  dateIso: string;
  startMin: number;
  durationMin: number;
  page: number;
}

const TARGET_PAGE = 8;
const SLOT_BUTTONS = 12;

/**
 * UC-14 / 5.6.3: student or group (recent first) → day → time (free slots or text) → duration → create.
 * A conflict (3а) names the busy party and re-offers the day's free slots; a lesson outside the windows is
 * created anyway and only marked (2а, CAL-09).
 */
@Injectable()
export class CreateLessonFlow extends Flow<CreateLessonData> {
  readonly name = 'create-lesson';
  readonly firstStep = 'target';

  constructor(
    private readonly create: CreateLessonUseCase,
    private readonly query: LessonsQuery,
    private readonly slots: LessonSlotsQuery,
    private readonly profiles: TeacherProfileRepository,
    private readonly clock: Clock,
  ) {
    super();
  }

  async initial(ctx: BotContext, arg: unknown): Promise<CreateLessonData> {
    const preset = (arg ?? {}) as { target?: LessonTarget; label?: string };
    return {
      target: preset.target ?? null,
      label: preset.label ?? '',
      dateIso: '',
      startMin: 0,
      durationMin: 0,
      page: 1,
    };
  }

  /** With a preset target (card button, notification) the dialog starts at the day step. */
  override async start(ctx: BotContext, arg?: unknown): Promise<void> {
    const data = await this.initial(ctx, arg);
    const step = data.target ? 'day' : this.firstStep;
    const state: FlowState = { name: this.name, step, data, startedAt: Date.now() };
    ctx.session.flow = state;
    await this.steps[step]!.enter(ctx, data);
  }

  private async cancel(ctx: BotContext): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(ctx, ctx.t('cancel-done'), this.back(ctx));
    return { stay: true };
  }

  private back(ctx: BotContext): InlineKeyboard {
    return new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('today', 'day'));
  }

  private targetOf(item: LessonTargetItem): LessonTarget {
    return item.kind === 'group' ? { groupId: item.groupId } : { studentId: item.studentId };
  }

  private async renderTargets(ctx: BotContext, d: CreateLessonData): Promise<void> {
    if (!ctx.actor) return;
    const items = await this.query.targets(ctx.actor.account.id);
    if (items.length === 0) {
      ctx.session.flow = undefined;
      await renderMenu(ctx, ctx.t('lesson-new-no-targets'), this.back(ctx));
      return;
    }
    const slice = paginate(items, d.page, TARGET_PAGE);
    const kb = new InlineKeyboard();
    slice.items.forEach((item, i) => {
      const index = (slice.page - 1) * TARGET_PAGE + i;
      const label =
        item.kind === 'group' ? `${clip(item.label, 30)} · ${item.memberCount}` : clip(item.label, 34);
      const id = item.kind === 'group' ? item.groupId : item.studentId;
      kb.text(label, flowCb('target', 'pick', ...shortRef(id, index))).row();
    });
    if (slice.pages > 1) {
      if (slice.page > 1) kb.text(ctx.t('btn-prev-day'), flowCb('target', 'page', slice.page - 1));
      if (slice.page < slice.pages) kb.text(ctx.t('btn-next-day'), flowCb('target', 'page', slice.page + 1));
      kb.row();
    }
    kb.text(ctx.t('btn-cancel'), flowCb('target', 'cancel'));
    await renderMenu(ctx, ctx.t('lesson-new-target'), kb);
  }

  private async renderTime(ctx: BotContext, d: CreateLessonData): Promise<void> {
    if (!ctx.actor || !d.target) return;
    const zone = zoneOf(ctx);
    const teacherId = ctx.actor.account.id;
    const profile = await this.profiles.find(teacherId);
    const studentIds =
      'studentId' in d.target ? [d.target.studentId] : await this.query.groupMemberIds(d.target.groupId);
    const durationMin = d.durationMin || profile?.defaultDurationMin || 60;
    const slots = await this.slots.teacherSlots({
      teacherId,
      studentIds,
      dateIso: d.dateIso,
      zone,
      durationMin,
      bufferBeforeMin: profile?.bufferBeforeMin ?? 0,
      bufferAfterMin: profile?.bufferAfterMin ?? 0,
      notBefore: this.clock.now(),
    });
    const kb = new InlineKeyboard();
    slots.slice(0, SLOT_BUTTONS).forEach((slot, i) => {
      // minutes since local midnight: a colon in the payload would be split by the callback parser
      const local = DateTime.fromJSDate(slot.start, { zone });
      kb.text(fmtTime(slot.start, zone), flowCb('time', 'at', local.hour * 60 + local.minute));
      if (i % 4 === 3) kb.row();
    });
    if (slots.length % 4 !== 0 || slots.length === 0) kb.row();
    kb.text(ctx.t('btn-cancel'), flowCb('time', 'cancel'));
    await renderMenu(
      ctx,
      ctx.t(slots.length > 0 ? 'lesson-new-time' : 'lesson-new-time-no-slots', {
        day: fmtDay(d.dateIso, zone),
        who: escapeHtml(d.label),
        duration: durationMin,
      }),
      kb,
    );
  }

  readonly steps: Record<string, FlowStep<CreateLessonData>> = {
    target: {
      enter: (ctx, d) => this.renderTargets(ctx, d),
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.cancel(ctx);
        if (action === 'page') {
          d.page = Math.max(1, Number(args[0]) || 1);
          return { goto: 'target' };
        }
        if (action !== 'pick' || !ctx.actor) return { stay: true };
        const items = await this.query.targets(ctx.actor.account.id);
        const item = resolveRef(items, args[0], args[1], (t) =>
          t.kind === 'group' ? t.groupId : t.studentId,
        );
        if (!item) {
          await ctx.answerCallbackQuery({ text: ctx.t('callback-stale') }).catch(() => undefined);
          return { stay: true };
        }
        d.target = this.targetOf(item);
        d.label = item.label;
        return { goto: 'day' };
      },
    },
    day: {
      enter: async (ctx, d) => {
        const kb = dayPickerKeyboard(ctx, zoneOf(ctx), this.clock.now(), (iso) => flowCb('day', 'pick', iso));
        kb.text(ctx.t('btn-cancel'), flowCb('day', 'cancel'));
        await renderMenu(ctx, ctx.t('lesson-new-day', { who: escapeHtml(d.label) }), kb);
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.cancel(ctx);
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
        if (action === 'cancel') return this.cancel(ctx);
        const minutes = action === 'at' && /^\d{1,4}$/.test(args[0] ?? '') ? Number(args[0]) : NaN;
        if (!Number.isInteger(minutes) || minutes < 0 || minutes >= MINUTES_PER_DAY) return { stay: true };
        d.startMin = minutes;
        return { goto: 'duration' };
      },
      onText: async (ctx, d, text) => {
        const minutes = parseTimeInput(text);
        if (minutes === null) {
          await say(ctx, ctx.t('time-invalid'));
          return { stay: true };
        }
        d.startMin = minutes;
        return { goto: 'duration' };
      },
    },
    duration: {
      enter: async (ctx, d) => {
        const fallback = ctx.actor
          ? (await this.profiles.find(ctx.actor.account.id))?.defaultDurationMin
          : undefined;
        const preset = d.durationMin || fallback || 60;
        const kb = new InlineKeyboard()
          .text(ctx.t('btn-create-with-minutes', { n: preset }), flowCb('duration', 'dur', preset))
          .row();
        for (const min of LESSON_DURATION_OPTIONS)
          if (min !== preset) kb.text(ctx.t('btn-minutes', { n: min }), flowCb('duration', 'dur', min));
        kb.row().text(ctx.t('btn-cancel'), flowCb('duration', 'cancel'));
        await renderMenu(
          ctx,
          ctx.t('lesson-new-duration', {
            day: fmtDay(d.dateIso, zoneOf(ctx)),
            time: minutesLabel(d.startMin),
          }),
          kb,
        );
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.cancel(ctx);
        const n = Number(args[0]);
        if (action !== 'dur' || !Number.isInteger(n) || n <= 0) return { stay: true };
        d.durationMin = n;
        return { done: true };
      },
      onText: async (ctx, d, text) => {
        const n = /^\d{1,3}$/.test(text) ? Number(text) : NaN;
        if (!Number.isInteger(n) || n < 15 || n > 480) {
          await say(ctx, ctx.t('onb-duration-invalid'));
          return { stay: true };
        }
        d.durationMin = n;
        return { done: true };
      },
    },
  };

  async complete(ctx: BotContext, d: CreateLessonData): Promise<void | { goto: string }> {
    if (!ctx.actor || !d.target) {
      ctx.session.flow = undefined;
      return;
    }
    const zone = zoneOf(ctx);
    const startsAt = toInstant(d.dateIso, d.startMin, zone);
    if (!startsAt) {
      await say(ctx, ctx.t('time-nonexistent'));
      return { goto: 'time' };
    }
    try {
      const { lesson, externalBusy } = await this.create.execute(ctx.actor.actor, {
        target: d.target,
        startsAt,
        durationMin: d.durationMin,
      });
      const kb = new InlineKeyboard()
        .text(ctx.t('btn-lesson-card'), sectionCb('today', 'lesson', lesson.id))
        .text(ctx.t('btn-back'), sectionCb('today', 'day', d.dateIso));
      await renderMenu(
        ctx,
        ctx.t(lesson.outsideWindows ? 'lesson-created-outside' : 'lesson-created', {
          who: escapeHtml(d.label),
          day: fmtDay(d.dateIso, zone),
          time: `${fmtTime(lesson.startsAt, zone)}–${fmtTime(lesson.endsAt, zone)}`,
        }) + (externalBusy ? `\n\n${ctx.t('lesson-external-busy-warning')}` : ''), // 5.5.2 soft block
        kb,
      );
    } catch (error) {
      if (AppError.is(error, 'LESSON_CONFLICT')) {
        const who = error.details?.['who'];
        await say(
          ctx,
          ctx.t(
            who === 'teacher'
              ? 'lesson-conflict-teacher'
              : who === 'student'
                ? 'lesson-conflict-student'
                : 'lesson-conflict-race',
          ),
        );
        return { goto: 'time' }; // 3а: the day's free slots again
      }
      if (AppError.is(error, 'VALIDATION_ERROR') && error.details?.['reason'] === 'past') {
        await say(ctx, ctx.t('block-in-past'));
        return { goto: 'day' };
      }
      // a preset or stale target: the student left, the group was archived or emptied meanwhile
      if (
        AppError.is(error, 'LINK_NOT_ACTIVE') ||
        AppError.is(error, 'NOT_FOUND') ||
        AppError.is(error, 'CONFLICT') ||
        (AppError.is(error, 'VALIDATION_ERROR') && error.details?.['reason'] === 'empty_group')
      ) {
        ctx.session.flow = undefined;
        await renderMenu(ctx, ctx.t('lesson-target-gone'), this.back(ctx));
        return;
      }
      if (isTerminalFlowError(error)) ctx.session.flow = undefined;
      throw error;
    }
  }
}
