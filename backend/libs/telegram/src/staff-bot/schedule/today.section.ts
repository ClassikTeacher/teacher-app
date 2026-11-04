import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { DateTime } from 'luxon';
import { AppError } from '@shared/errors/app-error.js';
import { Clock, DAY_MS } from '@shared/time/clock.js';
import type { Actor } from '@modules/access/actor.js';
import { FeatureService } from '@modules/access/features/feature.service.js';
import { type DayItem, DayViewQuery } from '@modules/schedule/day-view.query.js';
import { CreateLessonUseCase } from '@modules/schedule/lessons/create-lesson.use-case.js';
import { type LessonView, LessonsQuery } from '@modules/schedule/lessons/lessons.query.js';
import { PersonalBlockUseCase } from '@modules/schedule/occupancy/personal-block.use-case.js';
import { SeriesUseCase } from '@modules/schedule/series/series.use-case.js';
import type { CreatedBot } from '../../core/bot-factory.js';
import type { BotContext } from '../../core/context.js';
import { escapeHtml, renderMenu, say } from '../../core/ui.js';
import { menuCb } from '../menu.js';
import { sectionCb, type StaffSectionModule } from '../section-module.js';
import { isUuid } from '@shared/ids/index.js';
import { AddBlockFlow } from './add-block.flow.js';
import { TeacherBulkCancelFlow } from './bulk-cancel.flow.js';
import { TeacherCancelLessonFlow } from './cancel-lesson.flow.js';
import { DeclineRequestFlow } from './decline-request.flow.js';
import { RequestsScreen } from './requests.screen.js';
import { RescheduleLessonFlow } from './reschedule-lesson.flow.js';
import { CreateSeriesFlow } from './create-series.flow.js';
import { PauseSeriesFlow } from './pause-series.flow.js';
import { SeriesScreen } from './series.screen.js';
import { LessonReportFlow, type LessonReportPreset } from './lesson-report.flow.js';
import { zoneOf } from './day-picker.js';
import { lessonButtonLabel, lessonCardText, lessonLine, lessonWho } from './lesson-format.js';
import {
  DAY_ISO,
  dayRange,
  daysRange,
  fmtDay,
  fmtDayOf,
  fmtTime,
  isIsoDay,
  isoDayOf,
  localDay,
} from './time-input.js';

const WEEK_DAYS = 7;

/**
 * StaffBot → Сегодня / Неделя (5.5.7): day and week lists of lessons and personal blocks, the lesson card with
 * "Повторить через неделю" (5.6.3), block removal. Reports («Итоги») join in M3-05.
 */
@Injectable()
export class TodaySection implements StaffSectionModule {
  readonly section = 'today' as const;

  constructor(
    private readonly view: DayViewQuery,
    private readonly lessons: LessonsQuery,
    private readonly createLesson: CreateLessonUseCase,
    private readonly blocks: PersonalBlockUseCase,
    private readonly seriesUseCase: SeriesUseCase,
    private readonly addBlock: AddBlockFlow,
    private readonly createSeries: CreateSeriesFlow,
    private readonly pauseSeries: PauseSeriesFlow,
    private readonly seriesScreen: SeriesScreen,
    private readonly reportFlow: LessonReportFlow,
    private readonly cancelFlow: TeacherCancelLessonFlow,
    private readonly bulkCancel: TeacherBulkCancelFlow,
    private readonly moveFlow: RescheduleLessonFlow,
    private readonly declineRequest: DeclineRequestFlow,
    private readonly requestsScreen: RequestsScreen,
    private readonly features: FeatureService,
    private readonly clock: Clock,
  ) {}

  register({ flows }: CreatedBot): void {
    flows
      .register(this.addBlock)
      .register(this.createSeries)
      .register(this.pauseSeries)
      .register(this.cancelFlow)
      .register(this.bulkCancel)
      .register(this.moveFlow)
      .register(this.declineRequest);
  }

  async open(ctx: BotContext, actor: Actor): Promise<void> {
    return this.day(ctx, actor, localDay(zoneOf(ctx), this.clock.now()).toFormat(DAY_ISO));
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    const arg = args[0];
    switch (action) {
      case 'day': // s:today:day[:<yyyy-MM-dd>]
        return this.day(ctx, actor, isIsoDay(arg) ? arg : undefined);
      case 'week':
        return this.week(ctx, actor);
      case 'block':
        return this.addBlock.start(ctx);
      case 'unblock': // s:today:unblock:<blockId> — re-renders the day the block started on
        return this.day(ctx, actor, arg ? await this.removeBlock(ctx, actor, arg) : undefined);
      case 'lesson':
        return arg ? this.card(ctx, actor, arg) : this.open(ctx, actor);
      case 'repeat': // 5.6.3 "Повторить через неделю"
        return arg ? this.repeat(ctx, actor, arg) : this.open(ctx, actor);
      case 'rep': // s:today:rep:<lessonId>:planned|topic|noshow|later — the report (UC-24), also from the notification
        return arg ? this.reportEntry(ctx, actor, arg, args[1]) : this.open(ctx, actor);
      case 'bulk': // UC-22 (feature bulk.cancel)
        return this.bulkCancel.start(ctx);
      case 'move': // UC-18, also from the reminder's button
        return arg ? this.moveLesson(ctx, actor, arg) : this.open(ctx, actor);
      case 'requests': // 5.5.5 / 5.7.4: open requests
        return this.requestsScreen.list(ctx, actor);
      case 'rq': // s:today:rq:<requestId>:ok|no|card — also from the notification's buttons
        return isUuid(arg) ? this.requestsScreen.action(ctx, actor, arg, args[1]) : this.open(ctx, actor);
      case 'cancel': // UC-20 by the teacher, also from the reminder's button
        return arg ? this.cancelLesson(ctx, actor, arg) : this.open(ctx, actor);
      case 'regular': // 5.6.3 "Сделать регулярным" → UC-15
        return arg ? this.makeRegular(ctx, actor, arg) : this.open(ctx, actor);
      case 'series':
        return this.seriesScreen.list(ctx, actor);
      case 'scard':
      case 'spause':
      case 'sresume':
      case 'send':
      case 'sendok':
        return this.seriesAction(ctx, actor, action, arg);
      default:
        return this.open(ctx, actor);
    }
  }

  private navKeyboard(ctx: BotContext, dateIso: string): InlineKeyboard {
    const zone = zoneOf(ctx);
    const today = localDay(zone, this.clock.now());
    return new InlineKeyboard()
      .text(ctx.t('btn-day-today'), sectionCb('today', 'day', today.toFormat(DAY_ISO)))
      .text(ctx.t('btn-day-tomorrow'), sectionCb('today', 'day', today.plus({ days: 1 }).toFormat(DAY_ISO)))
      .text(ctx.t('btn-day-week'), sectionCb('today', 'week'))
      .row()
      .text(ctx.t('btn-prev-day'), sectionCb('today', 'day', this.shift(dateIso, zone, -1)))
      .text(ctx.t('btn-next-day'), sectionCb('today', 'day', this.shift(dateIso, zone, 1)))
      .row();
  }

  private shift(dateIso: string, zone: string, days: number): string {
    return localDay(zone, dayRange(dateIso, zone).start, days).toFormat(DAY_ISO);
  }

  private line(ctx: BotContext, item: DayItem, zone: string): string {
    if (item.kind === 'lesson') return lessonLine(ctx, item.view, zone);
    const from = fmtTime(item.block.startsAt, zone);
    const to = fmtTime(item.block.endsAt, zone);
    return ctx
      .t('block-line', { from, to, title: item.block.title ? escapeHtml(item.block.title) : '' })
      .trim();
  }

  /** The bulk button only while the feature is on for the teacher (5.3.3). */
  private async footer(ctx: BotContext, actor: Actor, kb: InlineKeyboard): Promise<void> {
    kb.text(ctx.t('menu-lesson'), menuCb('open', 'lesson'))
      .text(ctx.t('btn-add-block'), sectionCb('today', 'block'))
      .row()
      .text(ctx.t('btn-series'), sectionCb('today', 'series'))
      .text(ctx.t('btn-requests'), sectionCb('today', 'requests'));
    if (await this.features.isEnabled(actor.accountId, 'bulk.cancel'))
      kb.text(ctx.t('btn-cancel-many'), sectionCb('today', 'bulk'));
    kb.row().text(ctx.t('btn-back'), 'm:main');
  }

  /** Series actions on the teacher's own series (8.0); a vanished or foreign id falls back to the list. */
  private async seriesAction(
    ctx: BotContext,
    actor: Actor,
    action: string,
    id: string | undefined,
  ): Promise<void> {
    if (!isUuid(id)) return this.seriesScreen.list(ctx, actor);
    let series;
    try {
      series = await this.seriesUseCase.get(actor, id);
    } catch (error) {
      if (!AppError.is(error, 'NOT_FOUND')) throw error;
      return this.seriesScreen.list(ctx, actor);
    }
    try {
      switch (action) {
        case 'spause':
          return await this.pauseSeries.start(ctx, { seriesId: series.id });
        case 'sresume':
          await this.seriesUseCase.resume(actor, series.id);
          await say(ctx, ctx.t('series-resumed'));
          return await this.seriesScreen.card(ctx, actor, await this.seriesUseCase.get(actor, series.id));
        case 'send':
          return await this.seriesScreen.confirmEnd(ctx, series);
        case 'sendok':
          await this.seriesUseCase.end(actor, series.id, this.seriesScreen.todayIso(ctx, this.clock.now()));
          await say(ctx, ctx.t('series-ended'));
          return await this.seriesScreen.list(ctx, actor);
        default:
          return await this.seriesScreen.card(ctx, actor, series);
      }
    } catch (error) {
      if (!AppError.is(error, 'CONFLICT')) throw error; // already ended meanwhile
      await ctx.answerCallbackQuery({ text: ctx.t('callback-stale') }).catch(() => undefined);
      return this.seriesScreen.list(ctx, actor);
    }
  }

  /** «Как прошло занятие?» buttons (LES-06) and the card's «Итоги»: starts the report dialog at the right step. */
  private async reportEntry(
    ctx: BotContext,
    actor: Actor,
    lessonId: string,
    entry: string | undefined,
  ): Promise<void> {
    if (entry === 'later') {
      await say(ctx, ctx.t('report-later'));
      return;
    }
    const view = await this.lessonOf(ctx, actor, lessonId);
    if (!view) return;
    if (
      view.lesson.status === 'completed' ||
      view.lesson.status === 'not_held' ||
      view.lesson.status === 'cancelled'
    ) {
      await say(ctx, ctx.t('report-already'));
      return this.card(ctx, actor, lessonId);
    }
    if (view.lesson.endsAt.getTime() > this.clock.now().getTime()) {
      await say(ctx, ctx.t('report-not-over'));
      return this.card(ctx, actor, lessonId);
    }
    const zone = zoneOf(ctx);
    const preset: LessonReportPreset = {
      lessonId,
      who: lessonWho(ctx, view),
      when: `${fmtDayOf(view.lesson.startsAt, zone)} ${fmtTime(view.lesson.startsAt, zone)}`,
      plannedTopic: view.lesson.plannedTopic,
      participants: view.participants.map((p) => ({ studentId: p.student.id, name: p.displayName })),
      entry: entry === 'planned' || entry === 'noshow' ? entry : 'topic',
    };
    await this.reportFlow.start(ctx, preset);
  }

  /** UC-18: only a scheduled lesson moves; anything else gets a short notice and the card. */
  private async moveLesson(ctx: BotContext, actor: Actor, lessonId: string): Promise<void> {
    if (!isUuid(lessonId)) return this.open(ctx, actor);
    try {
      await this.moveFlow.start(ctx, { lessonId });
    } catch (error) {
      if (AppError.is(error, 'NOT_FOUND')) return this.open(ctx, actor);
      if (!AppError.is(error, 'CONFLICT')) throw error;
      await say(ctx, ctx.t('cancel-not-possible', { code: 'conflict', hours: 0 }));
      return this.card(ctx, actor, lessonId);
    }
  }

  /** A lesson already over, cancelled or reported cannot be cancelled: a short notice and the card (CNL-02). */
  private async cancelLesson(ctx: BotContext, actor: Actor, lessonId: string): Promise<void> {
    if (!isUuid(lessonId)) return this.open(ctx, actor);
    try {
      await this.cancelFlow.start(ctx, { lessonId });
    } catch (error) {
      if (AppError.is(error, 'NOT_FOUND')) return this.open(ctx, actor);
      if (!AppError.is(error, 'CONFLICT')) throw error;
      await say(ctx, ctx.t('cancel-not-possible', { code: 'conflict', hours: 0 }));
      return this.card(ctx, actor, lessonId);
    }
  }

  /** Preset from the lesson: participants, weekday, time, duration, subject; the dialog asks only days and end. */
  private async makeRegular(ctx: BotContext, actor: Actor, lessonId: string): Promise<void> {
    const view = await this.lessonOf(ctx, actor, lessonId);
    if (!view) return;
    const zone = zoneOf(ctx);
    const { lesson } = view;
    const target = lesson.groupId
      ? { groupId: lesson.groupId }
      : view.participants[0]
        ? { studentId: view.participants[0].student.id }
        : null;
    if (!target) return say(ctx, ctx.t('lesson-no-participants'));
    const local = DateTime.fromJSDate(lesson.startsAt, { zone });
    await this.createSeries.start(ctx, {
      target,
      label: lessonWho(ctx, view),
      startMin: local.hour * 60 + local.minute,
      durationMin: Math.round((lesson.endsAt.getTime() - lesson.startsAt.getTime()) / 60_000),
      weekday: local.weekday,
      startsOn: local.toISODate()!,
      subjectId: lesson.subjectId,
    });
  }

  private async day(ctx: BotContext, actor: Actor, dateIso?: string): Promise<void> {
    const zone = zoneOf(ctx);
    const iso = dateIso ?? localDay(zone, this.clock.now()).toFormat(DAY_ISO);
    const items = await this.view.items(actor.accountId, dayRange(iso, zone));
    const kb = this.navKeyboard(ctx, iso);
    for (const item of items) {
      if (item.kind === 'lesson') {
        kb.text(
          lessonButtonLabel(ctx, item.view, zone),
          sectionCb('today', 'lesson', item.view.lesson.id),
        ).row();
      } else {
        const time = `${fmtTime(item.block.startsAt, zone)}–${fmtTime(item.block.endsAt, zone)}`;
        kb.text(ctx.t('btn-remove-block', { time }), sectionCb('today', 'unblock', item.block.id)).row();
      }
    }
    await this.footer(ctx, actor, kb);
    const body = items.map((i) => this.line(ctx, i, zone)).join('\n') || ctx.t('schedule-day-empty');
    await renderMenu(ctx, ctx.t('schedule-day', { day: fmtDay(iso, zone), items: body }), kb);
  }

  private async week(ctx: BotContext, actor: Actor): Promise<void> {
    const zone = zoneOf(ctx);
    const start = localDay(zone, this.clock.now());
    const items = await this.view.items(actor.accountId, daysRange(start.toFormat(DAY_ISO), zone, WEEK_DAYS));
    const byDay = new Map<string, DayItem[]>();
    for (const item of items) {
      const key = isoDayOf(item.at, zone);
      byDay.set(key, [...(byDay.get(key) ?? []), item]);
    }
    const lines: string[] = [];
    const kb = new InlineKeyboard();
    for (let i = 0; i < WEEK_DAYS; i += 1) {
      const iso = start.plus({ days: i }).toFormat(DAY_ISO);
      const day = byDay.get(iso) ?? [];
      lines.push(`<b>${fmtDay(iso, zone)}</b>`);
      lines.push(day.map((x) => this.line(ctx, x, zone)).join('\n') || ctx.t('schedule-week-day-empty'));
      kb.text(fmtDay(iso, zone), sectionCb('today', 'day', iso));
      if (i % 4 === 3) kb.row();
    }
    kb.row();
    await this.footer(ctx, actor, kb);
    await renderMenu(
      ctx,
      ctx.t('schedule-week', {
        from: fmtDay(start.toFormat(DAY_ISO), zone),
        to: fmtDay(start.plus({ days: WEEK_DAYS - 1 }).toFormat(DAY_ISO), zone),
        items: lines.join('\n'),
      }),
      kb,
    );
  }

  /** The teacher's own lesson (8.0): a foreign or vanished id falls back to today's list. */
  private async lessonOf(ctx: BotContext, actor: Actor, lessonId: string): Promise<LessonView | null> {
    try {
      return await this.lessons.teacherLesson(actor.accountId, lessonId);
    } catch (error) {
      if (!AppError.is(error, 'NOT_FOUND')) throw error;
      await this.open(ctx, actor);
      return null;
    }
  }

  async card(ctx: BotContext, actor: Actor, lessonId: string): Promise<void> {
    const view = await this.lessonOf(ctx, actor, lessonId);
    if (!view) return;
    const zone = zoneOf(ctx);
    const kb = new InlineKeyboard();
    const over = view.lesson.endsAt.getTime() <= this.clock.now().getTime();
    if ((view.lesson.status === 'awaiting_report' || view.lesson.status === 'scheduled') && over)
      kb.text(ctx.t('btn-lesson-report'), sectionCb('today', 'rep', view.lesson.id, 'topic')).row();
    if (view.lesson.status === 'scheduled' && !over)
      kb.text(ctx.t('btn-lesson-cancel'), sectionCb('today', 'cancel', view.lesson.id))
        .text(ctx.t('btn-lesson-move'), sectionCb('today', 'move', view.lesson.id))
        .row();
    if (view.lesson.status !== 'cancelled') {
      // 5.9.3 «Через занятие» (M5-02); the materials section itself checks the feature
      kb.text(ctx.t('btn-lesson-materials'), sectionCb('materials', 'lesson', view.lesson.id));
      // 5.6.4 «отметки» (M6-01): the journals section checks the features itself
      if (view.lesson.status === 'completed')
        kb.text(ctx.t('btn-lesson-grades'), sectionCb('journals', 'lesson', view.lesson.id));
      kb.row();
      kb.text(ctx.t('btn-repeat-next-week'), sectionCb('today', 'repeat', view.lesson.id));
      if (!view.lesson.seriesId)
        kb.text(ctx.t('btn-make-regular'), sectionCb('today', 'regular', view.lesson.id));
      kb.row();
    }
    kb.text(ctx.t('btn-back'), sectionCb('today', 'day', isoDayOf(view.lesson.startsAt, zone)));
    await renderMenu(ctx, lessonCardText(ctx, view, zone), kb);
  }

  /** Same participants, same subject and duration, seven days later; a conflict is explained (CAL-06). */
  private async repeat(ctx: BotContext, actor: Actor, lessonId: string): Promise<void> {
    const view = await this.lessonOf(ctx, actor, lessonId);
    if (!view) return;
    const zone = zoneOf(ctx);
    const { lesson } = view;
    const target = lesson.groupId
      ? { groupId: lesson.groupId }
      : view.participants[0]
        ? { studentId: view.participants[0].student.id }
        : null;
    if (!target) return say(ctx, ctx.t('lesson-no-participants'));
    const startsAt = new Date(lesson.startsAt.getTime() + 7 * DAY_MS);
    try {
      const created = await this.createLesson.execute(actor, {
        target,
        startsAt,
        durationMin: Math.round((lesson.endsAt.getTime() - lesson.startsAt.getTime()) / 60_000),
        subjectId: lesson.subjectId,
        format: lesson.format,
        location: lesson.location,
        meetingUrl: lesson.meetingUrl,
      });
      await say(
        ctx,
        ctx.t('lesson-repeated', {
          who: escapeHtml(lessonWho(ctx, view)),
          day: fmtDayOf(created.lesson.startsAt, zone),
          time: fmtTime(created.lesson.startsAt, zone),
        }),
      );
      return this.card(ctx, actor, created.lesson.id);
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
        return this.card(ctx, actor, lessonId);
      }
      if (AppError.is(error, 'LINK_NOT_ACTIVE') || AppError.is(error, 'CONFLICT')) {
        await say(ctx, ctx.t('lesson-repeat-impossible'));
        return this.card(ctx, actor, lessonId);
      }
      throw error;
    }
  }

  /** A block removed meanwhile or a foreign id: a short notice; returns the day to re-render (today when unknown). */
  private async removeBlock(ctx: BotContext, actor: Actor, blockId: string): Promise<string | undefined> {
    try {
      const removed = await this.blocks.remove(actor, blockId);
      await ctx.answerCallbackQuery({ text: ctx.t('block-removed') }).catch(() => undefined);
      return isoDayOf(removed.startsAt, zoneOf(ctx));
    } catch (error) {
      if (!AppError.is(error, 'CONFLICT') && !AppError.is(error, 'NOT_FOUND')) throw error;
      await ctx.answerCallbackQuery({ text: ctx.t('callback-stale') }).catch(() => undefined);
      return undefined;
    }
  }
}
