import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import type { Actor } from '@modules/access/actor.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import {
  type RequestView,
  RescheduleRequestUseCase,
} from '@modules/schedule/reschedule/reschedule-request.use-case.js';
import type { BotContext } from '../../core/context.js';
import { clip, fullName } from '../../core/format.js';
import { escapeHtml, renderMenu, say } from '../../core/ui.js';
import { sectionCb } from '../section-module.js';
import { zoneOf } from './day-picker.js';
import { DeclineRequestFlow } from './decline-request.flow.js';
import { fmtDayOf, fmtTime } from './time-input.js';

/**
 * StaffBot → Заявки (5.5.5, 5.7.4): the teacher's open requests, a card with «Подтвердить / Отклонить» (a plea
 * only closes), accept → the move through CAL-01 («слот занят» explained), decline → a message to the student.
 */
@Injectable()
export class RequestsScreen {
  constructor(
    private readonly requests: RescheduleRequestUseCase,
    private readonly accounts: AccountRepository,
    private readonly decline: DeclineRequestFlow,
  ) {}

  private when(ctx: BotContext, at: Date | null): string {
    const zone = zoneOf(ctx);
    return at ? `${fmtDayOf(at, zone)} ${fmtTime(at, zone)}` : '—';
  }

  private async vars(ctx: BotContext, v: RequestView): Promise<Record<string, string>> {
    const student = await this.accounts.findById(v.request.studentId);
    return {
      kind: v.request.kind,
      student: escapeHtml(student ? fullName(student) : '—'),
      lessonWhen: this.when(ctx, v.lesson?.startsAt ?? null),
      when: this.when(ctx, v.request.startsAt),
      comment: escapeHtml(v.request.comment ?? ''),
    };
  }

  async list(ctx: BotContext, actor: Actor): Promise<void> {
    const items = await this.requests.pendingForTeacher(actor);
    const kb = new InlineKeyboard();
    const lines: string[] = [];
    for (const v of items.slice(0, 20)) {
      const vars = await this.vars(ctx, v);
      lines.push(ctx.t('request-line', vars));
      const label = `${vars['student']} ${vars['when'] === '—' ? vars['lessonWhen'] : vars['when']}`;
      kb.text(clip(label, 40), sectionCb('today', 'rq', v.request.id, 'card')).row();
    }
    kb.text(ctx.t('btn-back'), sectionCb('today', 'day'));
    const text =
      items.length > 0
        ? ctx.t('requests-list', { count: items.length, items: lines.join(String.fromCharCode(10)) })
        : ctx.t('requests-empty');
    await renderMenu(ctx, text, kb);
  }

  async card(ctx: BotContext, actor: Actor, requestId: string): Promise<void> {
    let v: RequestView;
    try {
      v = await this.requests.view(actor, requestId);
    } catch (error) {
      if (!AppError.is(error, 'NOT_FOUND')) throw error;
      return this.list(ctx, actor);
    }
    const kb = new InlineKeyboard();
    if (v.request.status === 'pending') {
      if (v.request.kind === 'reschedule_ask')
        kb.text(ctx.t('btn-request-close'), sectionCb('today', 'rq', v.request.id, 'no')).row();
      else
        kb.text(ctx.t('btn-request-accept'), sectionCb('today', 'rq', v.request.id, 'ok'))
          .text(ctx.t('btn-request-decline'), sectionCb('today', 'rq', v.request.id, 'no'))
          .row();
    }
    if (v.lesson) kb.text(ctx.t('btn-lesson-card'), sectionCb('today', 'lesson', v.lesson.id)).row();
    kb.text(ctx.t('btn-back'), sectionCb('today', 'requests'));
    const status = v.request.status === 'pending' ? '' : ` ${ctx.t('request-gone')}`;
    await renderMenu(ctx, ctx.t('request-card', await this.vars(ctx, v)) + status, kb);
  }

  /** `s:today:rq:<id>:ok|no|card` — from the list, the card or the notification's buttons. */
  async action(ctx: BotContext, actor: Actor, requestId: string, action: string | undefined): Promise<void> {
    if (action === 'no') return this.decline.start(ctx, { requestId });
    if (action !== 'ok') return this.card(ctx, actor, requestId);
    try {
      const decided = await this.requests.decide(actor, { requestId, accept: true });
      const key =
        decided.decisionReason === 'acknowledged'
          ? 'request-acknowledged'
          : decided.status === 'accepted'
            ? 'request-accepted'
            : decided.decisionReason === 'slot_taken'
              ? 'request-slot-taken'
              : decided.decisionReason === 'lesson_changed'
                ? 'request-gone'
                : 'request-declined';
      await say(ctx, ctx.t(key, { when: this.when(ctx, decided.startsAt) }));
    } catch (error) {
      if (!AppError.is(error, 'CONFLICT') && !AppError.is(error, 'NOT_FOUND')) throw error;
      await say(ctx, ctx.t('request-gone'));
    }
    return this.list(ctx, actor);
  }
}
