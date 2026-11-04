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
import { fullName } from '../core/format.js';
import { type SectionModule, sectionCb } from '../core/sections.js';
import { escapeHtml, renderMenu } from '../core/ui.js';
import { PersonBulkCancelFlow } from '../person/bulk-cancel.flow.js';
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
import { ChildrenSection } from './children.section.js';
import type { ParentSection } from './sections.js';

const AHEAD_DAYS = 14;
const MAX_ITEMS = 20;

/** ParentBot → Расписание ребёнка (5.5.3): the selected child's lessons in the parent's zone; actions arrive in M4. */
@Injectable()
export class ParentScheduleSection implements SectionModule<ParentSection> {
  readonly section = 'schedule' as const;

  constructor(
    private readonly query: PersonScheduleQuery,
    private readonly children: ChildrenSection,
    private readonly cancelFlow: PersonCancelLessonFlow,
    private readonly bulkFlow: PersonBulkCancelFlow,
    private readonly requestFlow: RescheduleRequestFlow,
    private readonly objectionFlow: MoveObjectionFlow,
    private readonly reschedule: RescheduleLessonUseCase,
    private readonly clock: Clock,
  ) {}

  register({ flows }: CreatedBot): void {
    flows
      .register(this.cancelFlow)
      .register(this.bulkFlow)
      .register(this.requestFlow)
      .register(this.objectionFlow);
  }

  async open(ctx: BotContext, actor: Actor): Promise<void> {
    const child = await this.children.selectedChild(ctx, actor.accountId);
    if (!child)
      return renderMenu(
        ctx,
        ctx.t('parent-schedule-no-child'),
        new InlineKeyboard().text(ctx.t('btn-back'), 'm:main'),
      );
    const zone = personZone(ctx);
    const now = DateTime.fromJSDate(this.clock.now(), { zone });
    const range = {
      start: now.startOf('day').toJSDate(),
      end: now.startOf('day').plus({ days: AHEAD_DAYS }).toJSDate(),
    };
    const items = (await this.query.forChild(actor, child.id, range)).slice(0, MAX_ITEMS);
    const kb = new InlineKeyboard();
    for (const v of items)
      kb.text(personLessonButton(ctx, v, zone), sectionCb('schedule', 'lesson', v.lesson.id)).row();
    if (items.length > 0) kb.text(ctx.t('btn-cancel-many'), sectionCb('schedule', 'bulk')).row();
    kb.text(ctx.t('btn-back'), 'm:main');
    const lines = items.map((v) => personLessonLine(ctx, v, zone)).join('\n');
    await renderMenu(
      ctx,
      ctx.t(items.length > 0 ? 'parent-schedule-child' : 'parent-schedule-child-empty', {
        child: escapeHtml(fullName(child)),
        days: AHEAD_DAYS,
        items: lines,
      }),
      kb,
    );
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    if (action === 'lesson' && isUuid(args[0])) return this.card(ctx, actor, args[0]);
    if (action === 'cancel' && isUuid(args[0])) return this.cancel(ctx, actor, args[0]);
    if (action === 'bulk') return this.bulk(ctx, actor);
    if (action === 'move' && isUuid(args[0])) return this.move(ctx, actor, args[0]);
    if (action === 'rok' && isUuid(args[0])) return this.acknowledge(ctx, actor, args[0]);
    if (action === 'rno' && isUuid(args[0])) return this.objection(ctx, actor, args[0]);
    return this.open(ctx, actor);
  }

  /** The child the lesson belongs to (the parent may have several); NOT_FOUND → the list. */
  private async childOf(ctx: BotContext, actor: Actor, lessonId: string): Promise<string | null> {
    try {
      return (await this.query.lesson(actor, lessonId)).studentId;
    } catch (error) {
      if (!AppError.is(error, 'NOT_FOUND')) throw error;
      await this.open(ctx, actor);
      return null;
    }
  }

  /** UC-19 for the child: a request with an open calendar, a plea otherwise. */
  private async move(ctx: BotContext, actor: Actor, lessonId: string): Promise<void> {
    const studentId = await this.childOf(ctx, actor, lessonId);
    if (!studentId) return;
    await this.requestFlow.tryStart(ctx, {
      lessonId,
      studentId,
      backCb: sectionCb('schedule', 'lesson', lessonId),
    });
  }

  private async objection(ctx: BotContext, actor: Actor, lessonId: string): Promise<void> {
    const studentId = await this.childOf(ctx, actor, lessonId);
    if (!studentId) return;
    await this.objectionFlow.start(ctx, {
      lessonId,
      studentId,
      backCb: sectionCb('schedule', 'lesson', lessonId),
    });
  }

  private async acknowledge(ctx: BotContext, actor: Actor, lessonId: string): Promise<void> {
    const studentId = await this.childOf(ctx, actor, lessonId);
    if (!studentId) return;
    await this.reschedule.acknowledge(actor, lessonId, studentId);
    await renderMenu(
      ctx,
      ctx.t('move-ack-done'),
      new InlineKeyboard().text(ctx.t('btn-cancel-back'), sectionCb('schedule', 'lesson', lessonId)),
    );
  }

  /** UC-23 for the selected child (Р-25). */
  private async bulk(ctx: BotContext, actor: Actor): Promise<void> {
    const child = await this.children.selectedChild(ctx, actor.accountId);
    if (!child) return this.open(ctx, actor);
    await this.bulkFlow.start(ctx, { studentId: child.id, backCb: sectionCb('schedule', 'list') });
  }

  /** UC-20 for the selected child (Р-25): the parent cancels or reports the child's absence. */
  private async cancel(ctx: BotContext, actor: Actor, lessonId: string): Promise<void> {
    let view;
    try {
      view = await this.query.lesson(actor, lessonId);
    } catch (error) {
      if (!AppError.is(error, 'NOT_FOUND')) throw error;
      return this.open(ctx, actor);
    }
    await this.cancelFlow.tryStart(ctx, {
      lessonId,
      studentId: view.studentId,
      backCb: sectionCb('schedule', 'lesson', lessonId),
    });
  }

  private async card(ctx: BotContext, actor: Actor, lessonId: string): Promise<void> {
    let view;
    try {
      view = await this.query.lesson(actor, lessonId);
    } catch (error) {
      if (!AppError.is(error, 'NOT_FOUND')) throw error;
      return this.open(ctx, actor);
    }
    const kb = new InlineKeyboard();
    if (view.lesson.status === 'scheduled' && view.lesson.startsAt > this.clock.now())
      kb.text(
        ctx.t(view.lesson.groupId ? 'btn-lesson-absence' : 'btn-lesson-cancel'),
        sectionCb('schedule', 'cancel', view.lesson.id),
      ).row();
    if (view.lesson.status === 'scheduled' && view.lesson.startsAt > this.clock.now() && !view.lesson.groupId)
      kb.text(ctx.t('btn-lesson-move'), sectionCb('schedule', 'move', view.lesson.id)).row();
    kb.text(ctx.t('btn-back'), sectionCb('schedule', 'list'));
    await renderMenu(ctx, personLessonCard(ctx, view, personZone(ctx)), kb);
  }
}
