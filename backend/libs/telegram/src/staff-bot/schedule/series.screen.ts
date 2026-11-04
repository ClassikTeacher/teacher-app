import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { DateTime } from 'luxon';
import type { Actor } from '@modules/access/actor.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { GroupRepository } from '@modules/people/groups/group.repository.js';
import { timeToMinutes } from '@modules/schedule/availability/windows.js';
import { parseRRule } from '@modules/schedule/series/rrule.js';
import { SeriesRepository } from '@modules/schedule/series/series.repository.js';
import { SeriesUseCase } from '@modules/schedule/series/series.use-case.js';
import type { LessonSeriesRow } from '@modules/schedule/schema.js';
import type { BotContext } from '../../core/context.js';
import { clip, fullName } from '../../core/format.js';
import { escapeHtml, renderMenu } from '../../core/ui.js';
import { sectionCb } from '../section-module.js';
import { WEEKDAY_KEYS } from '../settings/windows.screen.js';
import { zoneOf } from './day-picker.js';
import { fmtDay, minutesLabel } from './time-input.js';

/** «Сегодня → Серии» (5.5.6): the teacher's active series, a card with pause / resume / end. */
@Injectable()
export class SeriesScreen {
  constructor(
    private readonly series: SeriesUseCase,
    private readonly repo: SeriesRepository,
    private readonly accounts: AccountRepository,
    private readonly groups: GroupRepository,
  ) {}

  async who(series: LessonSeriesRow): Promise<string> {
    if (series.groupId) {
      const group = await this.groups.findById(series.groupId);
      return group ? `${group.emoji ? `${group.emoji} ` : ''}${group.name}` : '—';
    }
    const student = series.studentId ? await this.accounts.findById(series.studentId) : null;
    return student ? fullName(student) : '—';
  }

  /** Names for a whole list in two queries. */
  private async whoOf(items: readonly LessonSeriesRow[]): Promise<Map<string, string>> {
    const studentIds = items.map((s) => s.studentId).filter((id): id is string => id !== null);
    const groupIds = items.map((s) => s.groupId).filter((id): id is string => id !== null);
    const [students, groups] = await Promise.all([
      this.accounts.findByIds(studentIds),
      Promise.all(groupIds.map((id) => this.groups.findById(id))),
    ]);
    const studentById = new Map(students.map((a) => [a.id, fullName(a)]));
    const groupById = new Map(
      groups.flatMap((g) => (g ? [[g.id, `${g.emoji ? `${g.emoji} ` : ''}${g.name}`] as const] : [])),
    );
    return new Map(
      items.map((s) => [
        s.id,
        (s.groupId ? groupById.get(s.groupId) : studentById.get(s.studentId ?? '')) ?? '—',
      ]),
    );
  }

  days(ctx: BotContext, series: LessonSeriesRow): string {
    const rule = parseRRule(series.rrule);
    const names = rule.weekdays.map((d) => ctx.t(`weekday-${WEEKDAY_KEYS[d - 1]}`)).join(', ');
    return rule.intervalWeeks > 1 ? `${names} ×${rule.intervalWeeks}` : names;
  }

  private pausedMark(ctx: BotContext, s: LessonSeriesRow, zone: string): string {
    return s.pausedFrom && s.pausedTo
      ? ctx.t('series-paused-mark', { from: fmtDay(s.pausedFrom, zone), to: fmtDay(s.pausedTo, zone) })
      : '';
  }

  async list(ctx: BotContext, actor: Actor): Promise<void> {
    const zone = zoneOf(ctx);
    const items = await this.series.listActive(actor);
    const names = await this.whoOf(items);
    const kb = new InlineKeyboard();
    const lines: string[] = [];
    for (const s of items) {
      const who = names.get(s.id) ?? '—';
      lines.push(
        ctx.t('series-line', {
          who: escapeHtml(who),
          days: this.days(ctx, s),
          time: minutesLabel(timeToMinutes(s.startLocal)),
          duration: s.durationMin,
          paused: this.pausedMark(ctx, s, zone),
        }),
      );
      kb.text(
        clip(`${who} · ${this.days(ctx, s)} ${minutesLabel(timeToMinutes(s.startLocal))}`),
        sectionCb('today', 'scard', s.id),
      ).row();
    }
    kb.text(ctx.t('btn-back'), sectionCb('today', 'day'));
    const text = items.length > 0 ? `${ctx.t('series-list')}\n${lines.join('\n')}` : ctx.t('series-empty');
    await renderMenu(ctx, text, kb);
  }

  async card(ctx: BotContext, actor: Actor, series: LessonSeriesRow): Promise<void> {
    const zone = zoneOf(ctx);
    const count = (await this.repo.countInstances([series.id])).get(series.id) ?? 0;
    const kb = new InlineKeyboard();
    if (series.pausedFrom) kb.text(ctx.t('btn-resume-series'), sectionCb('today', 'sresume', series.id));
    else kb.text(ctx.t('btn-pause-series'), sectionCb('today', 'spause', series.id));
    kb.text(ctx.t('btn-end-series'), sectionCb('today', 'send', series.id)).row();
    kb.text(ctx.t('btn-back'), sectionCb('today', 'series'));
    await renderMenu(
      ctx,
      ctx.t('series-card', {
        who: escapeHtml(await this.who(series)),
        days: this.days(ctx, series),
        time: minutesLabel(timeToMinutes(series.startLocal)),
        duration: series.durationMin,
        from: fmtDay(series.startsOn, zone),
        until: series.endsOn
          ? ctx.t('series-until', { date: fmtDay(series.endsOn, zone) })
          : ctx.t('series-until-open'),
        count,
        paused: this.pausedMark(ctx, series, zone),
      }),
      kb,
    );
  }

  async confirmEnd(ctx: BotContext, series: LessonSeriesRow): Promise<void> {
    const count = (await this.repo.countInstances([series.id])).get(series.id) ?? 0;
    const kb = new InlineKeyboard()
      .text(ctx.t('btn-confirm-end-series'), sectionCb('today', 'sendok', series.id))
      .text(ctx.t('btn-cancel'), sectionCb('today', 'scard', series.id));
    await renderMenu(
      ctx,
      ctx.t('series-end-confirm', { who: escapeHtml(await this.who(series)), count }),
      kb,
    );
  }

  todayIso(ctx: BotContext, now: Date): string {
    return DateTime.fromJSDate(now, { zone: zoneOf(ctx) }).toISODate()!;
  }
}
