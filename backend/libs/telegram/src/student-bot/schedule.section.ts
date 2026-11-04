import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { DateTime } from 'luxon';
import { AppError } from '@shared/errors/app-error.js';
import { isUuid } from '@shared/ids/index.js';
import { Clock } from '@shared/time/clock.js';
import type { Actor } from '@modules/access/actor.js';
import { PersonScheduleQuery } from '@modules/schedule/lessons/person-schedule.query.js';
import type { CreatedBot } from '../core/bot-factory.js';
import type { BotContext } from '../core/context.js';
import { type SectionModule, sectionCb } from '../core/sections.js';
import { renderMenu } from '../core/ui.js';
import { PersonCancelLessonFlow } from '../person/cancel-lesson.flow.js';
import { MoveObjectionFlow } from '../person/move-objection.flow.js';
import { RescheduleRequestFlow } from '../person/reschedule-request.flow.js';
import { RescheduleLessonUseCase } from '@modules/schedule/reschedule/reschedule-lesson.use-case.js';
import {
  personLessonButton,
  personLessonCard,
  personLessonLine,
  personZone,
} from '../person/lesson-format.js';
import type { StudentSection } from './sections.js';

/** How far ahead and back the lists look (5.5.7). */
export const SCHEDULE_AHEAD_DAYS = 14;
export const SCHEDULE_BACK_DAYS = 14;
/** Telegram caps inline keyboards and message length: longer lists are cut with a hint. */
export const SCHEDULE_MAX_ITEMS = 20;

/**
 * StudentBot → Расписание (5.5.3): lessons at every teacher in the student's zone, a card with the lesson's
 * details and stub buttons for cancel / reschedule (M4-01, M4-03).
 */
@Injectable()
export class StudentScheduleSection implements SectionModule<StudentSection> {
  readonly section = 'schedule' as const;

  constructor(
    private readonly query: PersonScheduleQuery,
    private readonly cancelFlow: PersonCancelLessonFlow,
    private readonly requestFlow: RescheduleRequestFlow,
    private readonly objectionFlow: MoveObjectionFlow,
    private readonly reschedule: RescheduleLessonUseCase,
    private readonly clock: Clock,
  ) {}

  register({ flows }: CreatedBot): void {
    flows.register(this.cancelFlow).register(this.requestFlow).register(this.objectionFlow);
  }

  async open(ctx: BotContext, actor: Actor): Promise<void> {
    const zone = personZone(ctx);
    const now = DateTime.fromJSDate(this.clock.now(), { zone });
    const range = {
      start: now.startOf('day').toJSDate(),
      end: now.startOf('day').plus({ days: SCHEDULE_AHEAD_DAYS }).toJSDate(),
    };
    const all = await this.query.forStudent(actor, range);
    const items = all.slice(0, SCHEDULE_MAX_ITEMS);
    const kb = new InlineKeyboard();
    for (const v of items)
      kb.text(personLessonButton(ctx, v, zone), sectionCb('schedule', 'lesson', v.lesson.id)).row();
    kb.text(ctx.t('person-schedule-past'), sectionCb('schedule', 'past')).text(ctx.t('btn-back'), 'm:main');
    const lines = items.map((v) => personLessonLine(ctx, v, zone)).join('\n');
    await renderMenu(
      ctx,
      ctx.t(items.length > 0 ? 'person-schedule-list' : 'person-schedule-empty', {
        days: SCHEDULE_AHEAD_DAYS,
        items: lines,
      }),
      kb,
    );
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    switch (action) {
      case 'lesson':
        return isUuid(args[0]) ? this.card(ctx, actor, args[0]) : this.open(ctx, actor);
      case 'past':
        return this.past(ctx, actor);
      case 'soon':
        await renderMenu(
          ctx,
          ctx.t('person-lesson-actions-soon'),
          new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('schedule', 'list')),
        );
        return;
      case 'cancel': // UC-20 / UC-21, also from the reminder's button
        return isUuid(args[0]) ? this.cancel(ctx, actor, args[0]) : this.open(ctx, actor);
      case 'move': // UC-19: a request (open calendar) or a plea (closed), also from the reminder's button
        return isUuid(args[0]) ? this.move(ctx, actor, args[0]) : this.open(ctx, actor);
      case 'rok': // «ОК» on a move notice
        return isUuid(args[0]) ? this.acknowledge(ctx, actor, args[0]) : this.open(ctx, actor);
      case 'rno': // «Не могу в это время» on a move notice
        return isUuid(args[0])
          ? this.objectionFlow.start(ctx, {
              lessonId: args[0],
              studentId: actor.accountId,
              backCb: sectionCb('schedule', 'lesson', args[0]),
            })
          : this.open(ctx, actor);
      default:
        return this.open(ctx, actor);
    }
  }

  private async past(ctx: BotContext, actor: Actor): Promise<void> {
    const zone = personZone(ctx);
    const now = DateTime.fromJSDate(this.clock.now(), { zone });
    const range = {
      start: now.startOf('day').minus({ days: SCHEDULE_BACK_DAYS }).toJSDate(),
      end: this.clock.now(),
    };
    const all = await this.query.forStudent(actor, range, {
      includeCancelled: true,
      endedBefore: this.clock.now(),
    });
    const items = all.reverse().slice(0, SCHEDULE_MAX_ITEMS);
    const kb = new InlineKeyboard();
    for (const v of items)
      kb.text(personLessonButton(ctx, v, zone), sectionCb('schedule', 'lesson', v.lesson.id)).row();
    kb.text(ctx.t('btn-back'), sectionCb('schedule', 'list'));
    const lines = items.map((v) => personLessonLine(ctx, v, zone)).join('\n');
    await renderMenu(
      ctx,
      ctx.t(items.length > 0 ? 'person-schedule-past-list' : 'person-schedule-past-empty', {
        days: SCHEDULE_BACK_DAYS,
        items: lines,
      }),
      kb,
    );
  }

  private async cancel(ctx: BotContext, actor: Actor, lessonId: string): Promise<void> {
    await this.cancelFlow.tryStart(ctx, {
      lessonId,
      studentId: actor.accountId,
      backCb: sectionCb('schedule', 'lesson', lessonId),
    });
  }

  private async move(ctx: BotContext, actor: Actor, lessonId: string): Promise<void> {
    await this.requestFlow.tryStart(ctx, {
      lessonId,
      studentId: actor.accountId,
      backCb: sectionCb('schedule', 'lesson', lessonId),
    });
  }

  private async acknowledge(ctx: BotContext, actor: Actor, lessonId: string): Promise<void> {
    try {
      await this.reschedule.acknowledge(actor, lessonId);
    } catch (error) {
      if (!AppError.is(error, 'NOT_FOUND')) throw error;
      return this.open(ctx, actor);
    }
    await renderMenu(
      ctx,
      ctx.t('move-ack-done'),
      new InlineKeyboard().text(ctx.t('btn-cancel-back'), sectionCb('schedule', 'lesson', lessonId)),
    );
  }

  /** Own lessons only (8.0); a foreign id falls back to the list. */
  private async card(ctx: BotContext, actor: Actor, lessonId: string): Promise<void> {
    let view;
    try {
      view = await this.query.lesson(actor, lessonId);
    } catch (error) {
      if (!AppError.is(error, 'NOT_FOUND')) throw error;
      return this.open(ctx, actor);
    }
    const kb = new InlineKeyboard();
    if (view.lesson.status === 'scheduled' && view.lesson.startsAt > this.clock.now()) {
      kb.text(
        ctx.t(view.lesson.groupId ? 'btn-lesson-absence' : 'btn-lesson-cancel'),
        sectionCb('schedule', 'cancel', view.lesson.id),
      ).row();
      // a group lesson is moved by the teacher only (5.7.4)
      if (!view.lesson.groupId)
        kb.text(ctx.t('btn-lesson-move'), sectionCb('schedule', 'move', view.lesson.id)).row();
    }
    if (view.teacher.username)
      kb.url(ctx.t('btn-write-teacher'), `https://t.me/${view.teacher.username}`).row();
    kb.text(ctx.t('btn-back'), sectionCb('schedule', 'list'));
    await renderMenu(ctx, personLessonCard(ctx, view, personZone(ctx)), kb);
  }
}
