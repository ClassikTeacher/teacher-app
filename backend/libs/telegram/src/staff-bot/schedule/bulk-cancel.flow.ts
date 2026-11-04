import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import {
  BulkCancelUseCase,
  MAX_BULK_RANGE_DAYS,
  type TeacherSelection,
} from '@modules/schedule/cancellations/bulk-cancel.use-case.js';
import { CancelTemplatesQuery } from '@modules/schedule/cancellations/cancel-templates.query.js';
import { MAX_CANCEL_REASON_LENGTH } from '@modules/schedule/cancellations/cancel.rules.js';
import { type LessonView, LessonsQuery } from '@modules/schedule/lessons/lessons.query.js';
import type { BotContext } from '../../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../../core/flow.js';
import { clip } from '../../core/format.js';
import { escapeHtml, renderMenu, say } from '../../core/ui.js';
import {
  loadRange,
  parsePeriodInput,
  PERIOD_PRESETS,
  periodLabel,
  periodPreset,
  type PeriodPreset,
  type StoredRange,
  storeRange,
} from '../../person/bulk-period.js';
import { isTerminalFlowError } from '../common/flow-errors.js';
import { resolveRef, shortRef } from '../common/short-ref.js';
import { sectionCb } from '../section-module.js';
import { zoneOf } from './day-picker.js';
import { lessonWho } from './lesson-format.js';
import { DAY_ISO, daysRange, fmtDayOf, fmtTime, localDay } from './time-input.js';

/** The «pick from the list» mode shows this many days ahead; Telegram keyboards stay readable. */
export const PICK_DAYS = 14;
const PICK_MAX = 30;
/** Preview lines shown before «…и ещё N» (Telegram's 4096-character limit). */
const PREVIEW_LINES = 20;

export interface TeacherBulkData extends Record<string, unknown> {
  mode: 'pick' | 'period' | 'target' | null;
  selectedIds: string[];
  range: StoredRange | null;
  target: { studentId: string } | { groupId: string } | null;
  closeWindows: boolean;
  count: number;
  message: string;
  templateId: string | null;
  defaultText: string;
}

/**
 * UC-22 (5.7.5, feature `bulk.cancel`): mode → selection (list / period / student or group + period) → preview
 * with the late count and «закрыть окна» → one reason → confirm → one transaction (CNL-10).
 */
@Injectable()
export class TeacherBulkCancelFlow extends Flow<TeacherBulkData> {
  readonly name = 'teacher-bulk-cancel';
  readonly firstStep = 'mode';

  constructor(
    private readonly bulk: BulkCancelUseCase,
    private readonly templates: CancelTemplatesQuery,
    private readonly lessons: LessonsQuery,
    private readonly clock: Clock,
  ) {
    super();
  }

  async initial(ctx: BotContext): Promise<TeacherBulkData> {
    const options = await this.templates.forActor(ctx.actor!.actor, 'TEACHER');
    return {
      mode: null,
      selectedIds: [],
      range: null,
      target: null,
      closeWindows: false,
      count: 0,
      message: '',
      templateId: null,
      defaultText: options.find((t) => t.isDefault)?.text ?? '',
    };
  }

  private selection(d: TeacherBulkData): TeacherSelection {
    if (d.mode === 'pick') return { lessonIds: d.selectedIds };
    return { range: loadRange(d.range!), ...(d.target ? { target: d.target } : {}) };
  }

  private back(ctx: BotContext): InlineKeyboard {
    return new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('today', 'day'));
  }

  private async leave(ctx: BotContext, text: string): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(ctx, text, this.back(ctx));
    return { stay: true };
  }

  private async pickList(ctx: BotContext): Promise<LessonView[]> {
    const zone = zoneOf(ctx);
    const now = this.clock.now();
    const start = localDay(zone, now).toFormat(DAY_ISO);
    const all = await this.lessons.teacherLessons(ctx.actor!.account.id, daysRange(start, zone, PICK_DAYS), [
      'scheduled',
    ]);
    return all.filter((v) => v.lesson.endsAt.getTime() > now.getTime()).slice(0, PICK_MAX);
  }

  private line(ctx: BotContext, v: LessonView): string {
    const zone = zoneOf(ctx);
    return `${fmtDayOf(v.lesson.startsAt, zone)} ${fmtTime(v.lesson.startsAt, zone)} ${lessonWho(ctx, v)}`;
  }

  private periodKeyboard(ctx: BotContext, step: string): InlineKeyboard {
    const kb = new InlineKeyboard();
    for (const p of PERIOD_PRESETS) kb.text(ctx.t(`btn-bulk-${p}`), flowCb(step, 'preset', p));
    return kb
      .row()
      .text(ctx.t('btn-bulk-custom'), flowCb(step, 'custom'))
      .text(ctx.t('btn-cancel'), flowCb(step, 'cancel'));
  }

  private async applyPeriod(
    ctx: BotContext,
    d: TeacherBulkData,
    action: string,
    arg: string | undefined,
    text?: string,
  ): Promise<FlowNext> {
    const zone = zoneOf(ctx);
    const now = this.clock.now();
    if (action === 'cancel') return this.leave(ctx, ctx.t('cancel-done'));
    if (action === 'custom') {
      await say(ctx, ctx.t('bulk-custom-prompt', { max: MAX_BULK_RANGE_DAYS }));
      return { stay: true };
    }
    let range = null;
    if (action === 'preset' && PERIOD_PRESETS.includes(arg as PeriodPreset))
      range = periodPreset(arg as PeriodPreset, zone, now);
    if (action === 'text' && text !== undefined)
      range = parsePeriodInput(text, zone, now, MAX_BULK_RANGE_DAYS);
    if (!range) {
      await say(ctx, ctx.t('bulk-custom-invalid'));
      return { stay: true };
    }
    d.range = storeRange(range);
    return { goto: 'preview' };
  }

  readonly steps: Record<string, FlowStep<TeacherBulkData>> = {
    mode: {
      enter: async (ctx) => {
        const kb = new InlineKeyboard()
          .text(ctx.t('btn-bulk-mode-pick'), flowCb('mode', 'pick'))
          .row()
          .text(ctx.t('btn-bulk-mode-period'), flowCb('mode', 'period'))
          .row()
          .text(ctx.t('btn-bulk-mode-target'), flowCb('mode', 'target'))
          .row()
          .text(ctx.t('btn-cancel'), flowCb('mode', 'cancel'));
        await renderMenu(ctx, ctx.t('bulk-mode-prompt'), kb);
      },
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.leave(ctx, ctx.t('cancel-done'));
        if (action !== 'pick' && action !== 'period' && action !== 'target') return { stay: true };
        d.mode = action;
        return { goto: action };
      },
    },
    pick: {
      enter: async (ctx, d) => {
        const items = await this.pickList(ctx);
        if (items.length === 0)
          return this.leave(ctx, ctx.t('bulk-pick-empty', { days: PICK_DAYS })).then(() => undefined);
        const kb = new InlineKeyboard();
        items.forEach((v, i) => {
          const on = d.selectedIds.includes(v.lesson.id);
          kb.text(
            clip(`${on ? '☑️' : '⬜'} ${this.line(ctx, v)}`, 40),
            flowCb('pick', 't', ...shortRef(v.lesson.id, i)),
          ).row();
        });
        kb.text(ctx.t('btn-bulk-continue'), flowCb('pick', 'next')).text(
          ctx.t('btn-cancel'),
          flowCb('pick', 'cancel'),
        );
        await renderMenu(ctx, ctx.t('bulk-pick-prompt', { days: PICK_DAYS }), kb);
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.leave(ctx, ctx.t('cancel-done'));
        if (action === 'next') return d.selectedIds.length > 0 ? { goto: 'preview' } : { stay: true };
        if (action !== 't') return { stay: true };
        const items = await this.pickList(ctx);
        const picked = resolveRef(items, args[0], args[1], (v) => v.lesson.id);
        if (!picked) return { stay: true };
        const id = picked.lesson.id;
        d.selectedIds = d.selectedIds.includes(id)
          ? d.selectedIds.filter((x) => x !== id)
          : [...d.selectedIds, id];
        await this.steps['pick']!.enter(ctx, d);
        return { stay: true };
      },
    },
    period: {
      enter: async (ctx) => renderMenu(ctx, ctx.t('bulk-period-prompt'), this.periodKeyboard(ctx, 'period')),
      onCallback: (ctx, d, action, args) => this.applyPeriod(ctx, d, action, args[0]),
      onText: (ctx, d, text) => this.applyPeriod(ctx, d, 'text', undefined, text),
    },
    target: {
      enter: async (ctx) => {
        const targets = await this.lessons.targets(ctx.actor!.account.id);
        const kb = new InlineKeyboard();
        targets.forEach((t, i) => {
          const id = t.kind === 'student' ? t.studentId : t.groupId;
          kb.text(clip(t.label, 40), flowCb('target', 'pick', ...shortRef(id, i))).row();
        });
        kb.text(ctx.t('btn-cancel'), flowCb('target', 'cancel'));
        await renderMenu(ctx, ctx.t('bulk-target-prompt'), kb);
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.leave(ctx, ctx.t('cancel-done'));
        if (action !== 'pick') return { stay: true };
        const targets = await this.lessons.targets(ctx.actor!.account.id);
        const t = resolveRef(targets, args[0], args[1], (x) =>
          x.kind === 'student' ? x.studentId : x.groupId,
        );
        if (!t) return { stay: true };
        d.target = t.kind === 'student' ? { studentId: t.studentId } : { groupId: t.groupId };
        return { goto: 'targetPeriod' };
      },
    },
    targetPeriod: {
      enter: async (ctx) =>
        renderMenu(ctx, ctx.t('bulk-period-prompt'), this.periodKeyboard(ctx, 'targetPeriod')),
      onCallback: (ctx, d, action, args) => this.applyPeriod(ctx, d, action, args[0]),
      onText: (ctx, d, text) => this.applyPeriod(ctx, d, 'text', undefined, text),
    },
    preview: {
      enter: async (ctx, d) => {
        const preview = await this.bulk.previewTeacher(ctx.actor!.actor, this.selection(d));
        d.count = preview.items.length;
        if (preview.items.length === 0) {
          await this.leave(ctx, ctx.t('bulk-preview-empty'));
          return;
        }
        const ids = [...preview.items.map((i) => i.lesson.id), ...preview.excluded.map((e) => e.lesson.id)];
        const views = await this.lessons.teacherLessonsByIds(ctx.actor!.account.id, ids);
        const byId = new Map(views.map((v) => [v.lesson.id, v]));
        const line = (id: string) => escapeHtml(byId.has(id) ? this.line(ctx, byId.get(id)!) : '—');
        const shown = preview.items.slice(0, PREVIEW_LINES);
        const items = [
          ...shown.map((i) => `${i.isLate ? '⚠️ ' : ''}${line(i.lesson.id)}`),
          ...(preview.items.length > shown.length
            ? [ctx.t('bulk-preview-more', { count: preview.items.length - shown.length })]
            : []),
        ].join('\n');
        const excludedText = preview.excluded
          .slice(0, PREVIEW_LINES)
          .map(
            (e) =>
              `${line(e.lesson.id)} — ${ctx.t('bulk-excluded-code', { code: e.code.toLowerCase().replace(/_/g, '-') })}`,
          )
          .join('; ');
        const kb = new InlineKeyboard();
        if (d.mode === 'period')
          kb.text(
            ctx.t(d.closeWindows ? 'btn-bulk-close-windows-on' : 'btn-bulk-close-windows-off'),
            flowCb('preview', 'windows'),
          ).row();
        kb.text(ctx.t('btn-bulk-continue'), flowCb('preview', 'next')).text(
          ctx.t('btn-cancel'),
          flowCb('preview', 'cancel'),
        );
        await renderMenu(
          ctx,
          ctx.t('bulk-preview', {
            count: preview.items.length,
            late: preview.lateCount,
            items,
            excluded: excludedText ? ctx.t('bulk-preview-excluded', { items: excludedText }) : '',
          }),
          kb,
        );
      },
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.leave(ctx, ctx.t('cancel-done'));
        if (action === 'windows') {
          d.closeWindows = !d.closeWindows;
          await this.steps['preview']!.enter(ctx, d);
          return { stay: true };
        }
        return action === 'next' ? { goto: 'reason' } : { stay: true };
      },
    },
    reason: {
      enter: async (ctx, d) => {
        const options = (await this.templates.forActor(ctx.actor!.actor, 'TEACHER')).filter(
          (t) => !t.isDefault,
        );
        const kb = new InlineKeyboard();
        if (d.defaultText) kb.text(ctx.t('btn-cancel-send-default'), flowCb('reason', 'default')).row();
        options.forEach((t, i) =>
          kb.text(clip(t.text, 40), flowCb('reason', 'pick', ...shortRef(t.text, i))).row(),
        );
        kb.text(ctx.t('btn-cancel-own-text'), flowCb('reason', 'own')).text(
          ctx.t('btn-cancel'),
          flowCb('reason', 'cancel'),
        );
        await renderMenu(ctx, ctx.t('bulk-reason-prompt'), kb);
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.leave(ctx, ctx.t('cancel-done'));
        if (action === 'own') {
          await say(ctx, ctx.t('cancel-own-text-prompt', { max: MAX_CANCEL_REASON_LENGTH }));
          return { stay: true };
        }
        if (action === 'default' && d.defaultText) {
          d.message = d.defaultText;
          d.templateId = null;
          return { goto: 'confirm' };
        }
        if (action !== 'pick') return { stay: true };
        const options = (await this.templates.forActor(ctx.actor!.actor, 'TEACHER')).filter(
          (t) => !t.isDefault,
        );
        const picked = resolveRef(options, args[0], args[1], (t) => t.text);
        if (!picked) return { stay: true };
        d.message = picked.text;
        d.templateId = picked.id;
        return { goto: 'confirm' };
      },
      onText: async (ctx, d, text) => {
        const clean = text.trim();
        if (!clean || clean.length > MAX_CANCEL_REASON_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_CANCEL_REASON_LENGTH }));
          return { stay: true };
        }
        d.message = clean;
        d.templateId = null;
        return { goto: 'confirm' };
      },
    },
    confirm: {
      enter: async (ctx, d) => {
        const kb = new InlineKeyboard()
          .text(ctx.t('btn-bulk-confirm', { count: d.count }), flowCb('confirm', 'ok'))
          .text(ctx.t('btn-cancel'), flowCb('confirm', 'cancel'));
        await renderMenu(
          ctx,
          ctx.t('bulk-confirm', {
            count: d.count,
            message: escapeHtml(d.message),
            windows: d.closeWindows && d.range ? ctx.t('bulk-confirm-windows') : '',
          }),
          kb,
        );
      },
      onCallback: async (ctx, _d, action) => {
        if (action === 'cancel') return this.leave(ctx, ctx.t('cancel-done'));
        return action === 'ok' ? { done: true } : { stay: true };
      },
    },
  };

  async complete(ctx: BotContext, d: TeacherBulkData): Promise<void> {
    let result;
    try {
      result = await this.bulk.executeTeacher(ctx.actor!.actor, this.selection(d), {
        reason: d.message,
        templateId: d.templateId,
        closeWindows: d.closeWindows,
      });
    } catch (error) {
      if (isTerminalFlowError(error) || AppError.is(error, 'CANCEL_REASON_REQUIRED'))
        ctx.session.flow = undefined;
      throw error;
    }
    const text =
      result.items.length === 0
        ? ctx.t('bulk-done-empty')
        : ctx.t('bulk-done', { count: result.items.length, windows: result.closedDays.length });
    await renderMenu(ctx, text, this.back(ctx));
  }

  /** "20.10–26.10" for the confirmation texts. */
  periodText(ctx: BotContext, d: TeacherBulkData): string {
    return d.range ? periodLabel(loadRange(d.range), zoneOf(ctx)) : '';
  }
}
