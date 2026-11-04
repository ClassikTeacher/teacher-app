import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { DateTime } from 'luxon';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import {
  BulkCancelUseCase,
  type BulkPreview,
  MAX_BULK_RANGE_DAYS,
  type PersonSelection,
} from '@modules/schedule/cancellations/bulk-cancel.use-case.js';
import { CancelTemplatesQuery } from '@modules/schedule/cancellations/cancel-templates.query.js';
import { MAX_CANCEL_REASON_LENGTH } from '@modules/schedule/cancellations/cancel.rules.js';
import {
  type PersonLessonView,
  PersonScheduleQuery,
} from '@modules/schedule/lessons/person-schedule.query.js';
import type { BotContext } from '../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../core/flow.js';
import { clip, fullName } from '../core/format.js';
import { escapeHtml, renderMenu, say } from '../core/ui.js';
import { resolveRef, shortRef } from '../staff-bot/common/short-ref.js';
import {
  loadRange,
  parsePeriodInput,
  PERIOD_PRESETS,
  periodPreset,
  type PeriodPreset,
  type StoredRange,
  storeRange,
} from './bulk-period.js';
import { personZone } from './lesson-format.js';

export const PERSON_PICK_DAYS = 14;
const PICK_MAX = 30;
/** Preview lines shown before «…и ещё N» (Telegram's 4096-character limit). */
const PREVIEW_LINES = 20;

export interface PersonBulkPreset {
  /** The child for a parent (Р-25), the student's own id otherwise. */
  studentId: string;
  backCb: string;
}

export interface PersonBulkData extends Record<string, unknown>, PersonBulkPreset {
  mode: 'pick' | 'period' | 'teacher' | null;
  selectedIds: string[];
  range: StoredRange | null;
  teacherId: string | null;
  count: number;
  hasAbsences: boolean;
  message: string;
  templateId: string | null;
}

/**
 * UC-23 (5.7.5) in StudentBot and ParentBot: several from the list / a period at every teacher / a period at
 * one teacher → preview (group lessons become absence notices, forbidden ones are listed as excluded) → one
 * reason → confirm → one transaction; each teacher gets one summary (NTF-07).
 */
@Injectable()
export class PersonBulkCancelFlow extends Flow<PersonBulkData> {
  readonly name = 'person-bulk-cancel';
  readonly firstStep = 'mode';

  constructor(
    private readonly bulk: BulkCancelUseCase,
    private readonly templates: CancelTemplatesQuery,
    private readonly schedule: PersonScheduleQuery,
    private readonly links: TeacherStudentRepository,
    private readonly accounts: AccountRepository,
    private readonly clock: Clock,
  ) {
    super();
  }

  async initial(_ctx: BotContext, arg: unknown): Promise<PersonBulkData> {
    const preset = arg as PersonBulkPreset;
    return {
      ...preset,
      mode: null,
      selectedIds: [],
      range: null,
      teacherId: null,
      count: 0,
      hasAbsences: false,
      message: '',
      templateId: null,
    };
  }

  private role(ctx: BotContext): 'STUDENT' | 'PARENT' {
    return ctx.bot === 'parent' ? 'PARENT' : 'STUDENT';
  }

  private childId(ctx: BotContext, d: PersonBulkData): string | undefined {
    return this.role(ctx) === 'PARENT' ? d.studentId : undefined;
  }

  private selection(d: PersonBulkData): PersonSelection {
    if (d.mode === 'pick') return { lessonIds: d.selectedIds };
    return { range: loadRange(d.range!), ...(d.teacherId ? { teacherId: d.teacherId } : {}) };
  }

  private async leave(ctx: BotContext, d: PersonBulkData, text: string): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(ctx, text, new InlineKeyboard().text(ctx.t('btn-back'), d.backCb));
    return { stay: true };
  }

  /** Lessons visible to the person in the range (14 days ahead for the list; the chosen period otherwise). */
  private async views(
    ctx: BotContext,
    d: PersonBulkData,
    range?: { start: Date; end: Date },
  ): Promise<PersonLessonView[]> {
    const actor = ctx.actor!.actor;
    const zone = personZone(ctx);
    const now = DateTime.fromJSDate(this.clock.now(), { zone });
    const span = range ?? {
      start: now.startOf('day').toJSDate(),
      end: now.startOf('day').plus({ days: PERSON_PICK_DAYS }).toJSDate(),
    };
    const all =
      this.role(ctx) === 'PARENT'
        ? await this.schedule.forChild(actor, d.studentId, span)
        : await this.schedule.forStudent(actor, span);
    return all.filter((v) => v.lesson.status === 'scheduled' && v.lesson.startsAt > this.clock.now());
  }

  /** Only the next PICK_MAX for the keyboard. */
  private async pickList(ctx: BotContext, d: PersonBulkData): Promise<PersonLessonView[]> {
    return (await this.views(ctx, d)).slice(0, PICK_MAX);
  }

  private line(ctx: BotContext, v: PersonLessonView): string {
    const at = DateTime.fromJSDate(v.lesson.startsAt, { zone: personZone(ctx) }).setLocale('ru');
    return `${at.toFormat('ccc dd.MM HH:mm')} ${fullName(v.teacher)}`;
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
    d: PersonBulkData,
    action: string,
    arg: string | undefined,
    text?: string,
  ): Promise<FlowNext> {
    const zone = personZone(ctx);
    const now = this.clock.now();
    if (action === 'cancel') return this.leave(ctx, d, ctx.t('cancel-done'));
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

  readonly steps: Record<string, FlowStep<PersonBulkData>> = {
    mode: {
      enter: async (ctx) => {
        const kb = new InlineKeyboard()
          .text(ctx.t('btn-bulk-mode-pick'), flowCb('mode', 'pick'))
          .row()
          .text(ctx.t('btn-bulk-mode-period'), flowCb('mode', 'period'))
          .row()
          .text(ctx.t('btn-bulk-mode-teacher'), flowCb('mode', 'teacher'))
          .row()
          .text(ctx.t('btn-cancel'), flowCb('mode', 'cancel'));
        await renderMenu(ctx, ctx.t('bulk-mode-prompt'), kb);
      },
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.leave(ctx, d, ctx.t('cancel-done'));
        if (action !== 'pick' && action !== 'period' && action !== 'teacher') return { stay: true };
        d.mode = action;
        return { goto: action };
      },
    },
    pick: {
      enter: async (ctx, d) => {
        const items = await this.pickList(ctx, d);
        if (items.length === 0) {
          await this.leave(ctx, d, ctx.t('bulk-pick-empty', { days: PERSON_PICK_DAYS }));
          return;
        }
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
        await renderMenu(ctx, ctx.t('bulk-pick-prompt', { days: PERSON_PICK_DAYS }), kb);
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.leave(ctx, d, ctx.t('cancel-done'));
        if (action === 'next') return d.selectedIds.length > 0 ? { goto: 'preview' } : { stay: true };
        if (action !== 't') return { stay: true };
        const picked = resolveRef(await this.pickList(ctx, d), args[0], args[1], (v) => v.lesson.id);
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
    teacher: {
      enter: async (ctx, d) => {
        const teachers = await this.teachersOf(d.studentId);
        const kb = new InlineKeyboard();
        teachers.forEach((t, i) =>
          kb.text(clip(fullName(t), 40), flowCb('teacher', 'pick', ...shortRef(t.id, i))).row(),
        );
        kb.text(ctx.t('btn-cancel'), flowCb('teacher', 'cancel'));
        await renderMenu(ctx, ctx.t('bulk-teacher-prompt'), kb);
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.leave(ctx, d, ctx.t('cancel-done'));
        if (action !== 'pick') return { stay: true };
        const picked = resolveRef(await this.teachersOf(d.studentId), args[0], args[1], (t) => t.id);
        if (!picked) return { stay: true };
        d.teacherId = picked.id;
        return { goto: 'teacherPeriod' };
      },
    },
    teacherPeriod: {
      enter: async (ctx) =>
        renderMenu(ctx, ctx.t('bulk-period-prompt'), this.periodKeyboard(ctx, 'teacherPeriod')),
      onCallback: (ctx, d, action, args) => this.applyPeriod(ctx, d, action, args[0]),
      onText: (ctx, d, text) => this.applyPeriod(ctx, d, 'text', undefined, text),
    },
    preview: {
      enter: async (ctx, d) => {
        const preview = await this.bulk.previewPerson(
          ctx.actor!.actor,
          this.role(ctx),
          this.selection(d),
          this.childId(ctx, d),
        );
        d.count = preview.items.length;
        d.hasAbsences = preview.items.some((i) => i.outcome === 'absence');
        if (preview.items.length === 0 && preview.excluded.length === 0) {
          await this.leave(ctx, d, ctx.t('bulk-preview-empty'));
          return;
        }
        const text = await this.previewText(ctx, d, preview);
        const kb = new InlineKeyboard();
        if (preview.items.length > 0) kb.text(ctx.t('btn-bulk-continue'), flowCb('preview', 'next'));
        kb.text(ctx.t('btn-cancel'), flowCb('preview', 'cancel'));
        await renderMenu(ctx, text, kb);
      },
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.leave(ctx, d, ctx.t('cancel-done'));
        return action === 'next' && d.count > 0 ? { goto: 'reason' } : { stay: true };
      },
    },
    reason: {
      enter: async (ctx, d) => {
        const options = await this.templates.forActor(ctx.actor!.actor, this.role(ctx));
        const kb = new InlineKeyboard();
        options.forEach((t, i) =>
          kb.text(clip(t.text, 40), flowCb('reason', 'pick', ...shortRef(t.text, i))).row(),
        );
        kb.text(ctx.t('btn-cancel-own-text'), flowCb('reason', 'own')).text(
          ctx.t('btn-cancel'),
          flowCb('reason', 'cancel'),
        );
        const note = d.hasAbsences ? `\n${ctx.t('bulk-preview-absence-note')}` : '';
        await renderMenu(ctx, `${ctx.t('bulk-reason-prompt')}${note}`, kb);
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.leave(ctx, d, ctx.t('cancel-done'));
        if (action === 'own') {
          await say(ctx, ctx.t('cancel-own-text-prompt', { max: MAX_CANCEL_REASON_LENGTH }));
          return { stay: true };
        }
        if (action !== 'pick') return { stay: true };
        const options = await this.templates.forActor(ctx.actor!.actor, this.role(ctx));
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
          ctx.t('bulk-confirm', { count: d.count, message: escapeHtml(d.message), windows: '' }),
          kb,
        );
      },
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.leave(ctx, d, ctx.t('cancel-done'));
        return action === 'ok' ? { done: true } : { stay: true };
      },
    },
  };

  async complete(ctx: BotContext, d: PersonBulkData): Promise<void> {
    let result;
    try {
      result = await this.bulk.executePerson(
        ctx.actor!.actor,
        this.role(ctx),
        this.selection(d),
        { reason: d.message, templateId: d.templateId },
        this.childId(ctx, d),
      );
    } catch (error) {
      if (
        AppError.is(error, 'NOT_FOUND') ||
        AppError.is(error, 'FORBIDDEN') ||
        AppError.is(error, 'CANCEL_REASON_REQUIRED')
      )
        ctx.session.flow = undefined;
      throw error;
    }
    const text =
      result.items.length === 0
        ? ctx.t('bulk-done-empty')
        : ctx.t('bulk-done', { count: result.items.length, windows: 0 });
    await renderMenu(ctx, text, new InlineKeyboard().text(ctx.t('btn-back'), d.backCb));
  }

  /** Teachers the student actively studies with (8.0), for the «у одного учителя» mode. */
  private async teachersOf(studentId: string) {
    const links = await this.links.listByStudent(studentId, ['active']);
    return this.accounts.findByIds(links.map((l) => l.teacherId));
  }

  private async previewText(ctx: BotContext, d: PersonBulkData, preview: BulkPreview): Promise<string> {
    // one range query covers the batch and the excluded lessons; a lesson no longer visible shows as «—»
    const views = await this.views(ctx, d, d.mode === 'pick' ? undefined : loadRange(d.range!));
    const byId = new Map(views.map((v) => [v.lesson.id, v]));
    const line = (id: string) => escapeHtml(byId.has(id) ? this.line(ctx, byId.get(id)!) : '—');
    const shown = preview.items.slice(0, PREVIEW_LINES);
    const items = [
      ...shown.map(
        (i) => `${i.isLate ? '⚠️ ' : ''}${i.outcome === 'absence' ? '🙋 ' : ''}${line(i.lesson.id)}`,
      ),
      ...(preview.items.length > shown.length
        ? [ctx.t('bulk-preview-more', { count: preview.items.length - shown.length })]
        : []),
    ].join('\n');
    const excluded = preview.excluded
      .slice(0, PREVIEW_LINES)
      .map(
        (e) =>
          `${line(e.lesson.id)} — ${ctx.t('bulk-excluded-code', { code: e.code.toLowerCase().replace(/_/g, '-') })}`,
      )
      .join('; ');
    return ctx.t('bulk-preview', {
      count: preview.items.length,
      late: preview.lateCount,
      items: items || '—',
      excluded: excluded ? ctx.t('bulk-preview-excluded', { items: excluded }) : '',
    });
  }
}
