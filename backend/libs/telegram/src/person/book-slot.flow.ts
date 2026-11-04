import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { DateTime } from 'luxon';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { OpenSlotsQuery } from '@modules/schedule/availability/open-slots.query.js';
import { BookSlotUseCase, MAX_BOOKING_COMMENT_LENGTH } from '@modules/schedule/booking/book-slot.use-case.js';
import type { BotContext } from '../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../core/flow.js';
import { clip, fullName } from '../core/format.js';
import { escapeHtml, renderMenu, say } from '../core/ui.js';
import { dayPickerKeyboard } from '../staff-bot/schedule/day-picker.js';
import { resolveRef, shortRef } from '../staff-bot/common/short-ref.js';
import { dayRange, fmtDay, fmtTime, isIsoDay, parseDayInput } from '../staff-bot/schedule/time-input.js';
import { personZone } from './lesson-format.js';

const SLOT_BUTTONS = 16;

export interface BookSlotData extends Record<string, unknown> {
  backCb: string;
  teacherId: string;
  teacher: string;
  mode: 'auto' | 'manual';
  durations: number[];
  durationMin: number;
  dateIso: string;
  startsAt: string | null;
  comment: string;
}

/**
 * UC-16 (5.5.5): teacher (if several are open) → day → open slot → duration (if several) → comment → confirm.
 * `auto` creates the lesson at once, `manual` sends a request. 1б / 1в / 2а are explained in place.
 */
@Injectable()
export class BookSlotFlow extends Flow<BookSlotData> {
  readonly name = 'book-slot';
  readonly firstStep = 'teacher';

  constructor(
    private readonly booking: BookSlotUseCase,
    private readonly openSlots: OpenSlotsQuery,
    private readonly accounts: AccountRepository,
    private readonly profiles: TeacherProfileRepository,
    private readonly clock: Clock,
  ) {
    super();
  }

  async initial(_ctx: BotContext, arg: unknown): Promise<BookSlotData> {
    const { backCb } = arg as { backCb: string };
    return {
      backCb,
      teacherId: '',
      teacher: '',
      mode: 'auto',
      durations: [],
      durationMin: 0,
      dateIso: '',
      startsAt: null,
      comment: '',
    };
  }

  private async leave(ctx: BotContext, d: BookSlotData, text: string): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(ctx, text, new InlineKeyboard().text(ctx.t('btn-back'), d.backCb));
    return { stay: true };
  }

  private async teachers(ctx: BotContext) {
    const links = await this.booking.openTeachers(ctx.actor!.actor);
    return this.accounts.findByIds(links.map((l) => l.teacherId));
  }

  /** Remembers the teacher and what they offer (durations, confirmation mode). */
  private async pickTeacher(ctx: BotContext, d: BookSlotData, teacherId: string): Promise<void> {
    const [teacher, profile] = await Promise.all([
      this.accounts.findById(teacherId),
      this.profiles.find(teacherId),
    ]);
    const { durations, durationMin } = await this.openSlots.slots(ctx.actor!.actor, {
      teacherId,
      range: { start: this.clock.now(), end: new Date(this.clock.now().getTime() + 864e5) },
    });
    d.teacherId = teacherId;
    d.teacher = teacher ? fullName(teacher) : '—';
    d.mode = profile?.bookingConfirmation ?? 'auto';
    d.durations = durations;
    d.durationMin = durationMin;
  }

  private async daySlots(ctx: BotContext, d: BookSlotData): Promise<Date[]> {
    const { slots } = await this.openSlots.slots(ctx.actor!.actor, {
      teacherId: d.teacherId,
      range: dayRange(d.dateIso, personZone(ctx)),
      durationMin: d.durationMin,
    });
    return slots.map((s) => s.start);
  }

  private when(ctx: BotContext, d: BookSlotData): string {
    if (!d.startsAt) return '—';
    return DateTime.fromJSDate(new Date(d.startsAt), { zone: personZone(ctx) })
      .setLocale('ru')
      .toFormat('cccc dd.MM HH:mm');
  }

  readonly steps: Record<string, FlowStep<BookSlotData>> = {
    teacher: {
      enter: async (ctx, d) => {
        const teachers = await this.teachers(ctx);
        if (teachers.length === 0) {
          await this.leave(ctx, d, ctx.t('book-no-open-teachers'));
          return;
        }
        if (teachers.length === 1) {
          // one open teacher: straight to the day (the step still renders the day picker)
          await this.pickTeacher(ctx, d, teachers[0]!.id);
          ctx.session.flow!.step = 'day';
          await this.steps['day']!.enter(ctx, d);
          return;
        }
        const kb = new InlineKeyboard();
        teachers.forEach((t, i) =>
          kb.text(clip(fullName(t), 40), flowCb('teacher', 'pick', ...shortRef(t.id, i))).row(),
        );
        kb.text(ctx.t('btn-cancel'), flowCb('teacher', 'cancel'));
        await renderMenu(ctx, ctx.t('book-teacher-prompt'), kb);
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.leave(ctx, d, ctx.t('cancel-done'));
        if (action !== 'pick') return { stay: true };
        const picked = resolveRef(await this.teachers(ctx), args[0], args[1], (t) => t.id);
        if (!picked) return { stay: true };
        await this.pickTeacher(ctx, d, picked.id);
        return { goto: 'day' };
      },
    },
    day: {
      enter: async (ctx, d) => {
        const kb = dayPickerKeyboard(ctx, personZone(ctx), this.clock.now(), (iso) =>
          flowCb('day', 'pick', iso),
        );
        kb.text(ctx.t('btn-cancel'), flowCb('day', 'cancel'));
        await renderMenu(ctx, ctx.t('book-day-prompt', { teacher: escapeHtml(d.teacher) }), kb);
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
        const key = slots.length > 0 ? 'book-slot-prompt' : 'book-slot-none';
        await renderMenu(ctx, ctx.t(key, { day: fmtDay(d.dateIso, zone), duration: d.durationMin }), kb);
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
        if (!picked) return { stay: true };
        d.startsAt = picked.toISOString();
        return { goto: d.durations.length > 1 ? 'duration' : 'comment' };
      },
    },
    duration: {
      enter: async (ctx, d) => {
        const kb = new InlineKeyboard();
        d.durations.forEach((m) => kb.text(`${m} мин`, flowCb('duration', 'pick', m)));
        kb.row().text(ctx.t('btn-cancel'), flowCb('duration', 'cancel'));
        await renderMenu(ctx, ctx.t('book-duration-prompt'), kb);
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.leave(ctx, d, ctx.t('cancel-done'));
        const m = Number(args[0]);
        if (action !== 'pick' || !d.durations.includes(m)) return { stay: true };
        d.durationMin = m;
        return { goto: 'comment' };
      },
    },
    comment: {
      enter: async (ctx) => {
        const kb = new InlineKeyboard()
          .text(ctx.t('btn-book-no-comment'), flowCb('comment', 'skip'))
          .row()
          .text(ctx.t('btn-cancel'), flowCb('comment', 'cancel'));
        await renderMenu(ctx, ctx.t('book-comment-prompt'), kb);
      },
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.leave(ctx, d, ctx.t('cancel-done'));
        if (action !== 'skip') return { stay: true };
        d.comment = '';
        return { goto: 'confirm' };
      },
      onText: async (ctx, d, text) => {
        const clean = text.trim();
        if (clean.length > MAX_BOOKING_COMMENT_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_BOOKING_COMMENT_LENGTH }));
          return { stay: true };
        }
        d.comment = clean;
        return { goto: 'confirm' };
      },
    },
    confirm: {
      enter: async (ctx, d) => {
        const kb = new InlineKeyboard()
          .text(ctx.t('btn-book-confirm'), flowCb('confirm', 'ok'))
          .text(ctx.t('btn-cancel'), flowCb('confirm', 'cancel'));
        await renderMenu(
          ctx,
          ctx.t('book-confirm', {
            teacher: escapeHtml(d.teacher),
            when: this.when(ctx, d),
            duration: d.durationMin,
            note: d.mode === 'manual' ? ctx.t('book-confirm-manual-note') : '',
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

  async complete(ctx: BotContext, d: BookSlotData): Promise<void | { goto: string }> {
    let result;
    try {
      result = await this.booking.book(ctx.actor!.actor, {
        teacherId: d.teacherId,
        startsAt: new Date(d.startsAt!),
        durationMin: d.durationMin,
        comment: d.comment || null,
      });
    } catch (error) {
      if (!AppError.is(error)) throw error;
      // 2а: the slot went a second ago (or is no longer open) — the day's list again
      if (
        error.code === 'LESSON_CONFLICT' ||
        (error.code === 'VALIDATION_ERROR' && error.details?.['reason'] === 'not_open')
      ) {
        await say(ctx, ctx.t('book-slot-taken'));
        return { goto: 'slot' };
      }
      if (error.code === 'WEEKLY_LIMIT_EXCEEDED') {
        const limit = error.details?.['limit'];
        return this.leave(
          ctx,
          d,
          ctx.t('book-weekly-limit', { limit: typeof limit === 'number' ? limit : 0 }),
        ).then(() => undefined);
      }
      if (error.code === 'SLOT_REQUESTS_FULL') {
        await say(ctx, ctx.t('book-requests-full'));
        return { goto: 'slot' };
      }
      if (error.code === 'CONFLICT' && error.details?.['reason'] === 'pending_exists') {
        await say(ctx, ctx.t('book-pending-exists'));
        return { goto: 'slot' };
      }
      ctx.session.flow = undefined;
      throw error;
    }
    const key = result.kind === 'lesson' ? 'book-done-lesson' : 'book-done-request';
    await renderMenu(
      ctx,
      ctx.t(key, { teacher: escapeHtml(d.teacher), when: this.when(ctx, d) }),
      new InlineKeyboard().text(ctx.t('btn-back'), d.backCb),
    );
  }
}
