import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { DateTime } from 'luxon';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { GradeEntriesUseCase } from '@modules/gradebook/grade-entries.use-case.js';
import { GradebookQuery } from '@modules/gradebook/gradebook.query.js';
import {
  DEFAULT_TEST_MAX,
  MAX_ENTRY_COMMENT_LENGTH,
  scaleValueLabel,
} from '@modules/gradebook/gradebook.rules.js';
import { JournalRepository } from '@modules/gradebook/journal.repository.js';
import { JournalsUseCase } from '@modules/gradebook/journals.use-case.js';
import {
  type JournalType,
  SCHOOL_CATEGORIES,
  type SchoolCategory,
  type TestParts,
} from '@modules/gradebook/schema.js';
import { cardDisplayName } from '@modules/people/links/students.query.js';
import type { BotContext, FlowState } from '../../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../../core/flow.js';
import { clip } from '../../core/format.js';
import { escapeHtml, renderMenu, say } from '../../core/ui.js';
import { isTerminalFlowError } from '../common/flow-errors.js';
import { parseDayInput } from '../schedule/time-input.js';
import { sectionCb } from '../section-module.js';

export interface GradeEntryPreset {
  /** Known journal (from the journal screen) — the dialog starts at the value. */
  journalId?: string;
  /** Otherwise: the students to grade one after another (lesson report, group), with the lesson's subject. */
  studentIds?: string[];
  subjectId?: string | null;
  lessonId?: string | null;
  assignmentId?: string | null;
  /** Editing an existing record: the value and the comment are asked again. */
  entryId?: string;
  /** ISO date preset by the caller (the lesson's day); otherwise the dialog asks. */
  date?: string | null;
  /** Callback of the «Назад» button after the dialog. */
  back?: string;
}

export interface GradeEntryData extends Record<string, unknown>, GradeEntryPreset {
  index: number;
  journalId?: string;
  type: JournalType | null;
  value: number | null;
  max: number | null;
  parts: TestParts | null;
  scaleValueId: string | null;
  category: SchoolCategory | null;
  testKindId: string | null;
  comment: string | null;
  date: string | null;
  /** Ids shown on the journal picker, for index references. */
  shownJournals: string[];
  shownKinds: string[];
  shownValues: string[];
  saved: number;
}

const SCORE =
  /^(\d+(?:[.,]\d+)?)(?:\s*\/\s*(\d+(?:[.,]\d+)?))?(?:\s*\(\s*(\d+(?:[.,]\d+)?)\s*[+ ]\s*(\d+(?:[.,]\d+)?)\s*\))?$/;

/**
 * UC-29: a record in a journal — journal (when not preset) → value → category or kind → date → comment → save,
 * then the next student of a group lesson. Buttons carry indexes into the lists drawn on the screen.
 */
@Injectable()
export class GradeEntryFlow extends Flow<GradeEntryData> {
  readonly name = 'grade-entry';
  readonly firstStep = 'journal';

  constructor(
    private readonly entries: GradeEntriesUseCase,
    private readonly journals: JournalsUseCase,
    private readonly repo: JournalRepository,
    private readonly query: GradebookQuery,
    private readonly clock: Clock,
  ) {
    super();
  }

  async initial(_ctx: BotContext, arg: unknown): Promise<GradeEntryData> {
    const preset = (arg as GradeEntryPreset | undefined) ?? {};
    return {
      ...preset,
      index: 0,
      type: null,
      value: null,
      max: null,
      parts: null,
      scaleValueId: null,
      category: null,
      testKindId: null,
      comment: null,
      date: preset.date ?? null,
      shownJournals: [],
      shownKinds: [],
      shownValues: [],
      saved: 0,
    };
  }

  override async start(ctx: BotContext, arg?: unknown): Promise<void> {
    const data = await this.initial(ctx, arg);
    if (data.journalId) {
      const journal = await this.repo.findById(data.journalId);
      data.type = journal?.type ?? null;
    }
    const step = data.journalId ? 'value' : 'journal';
    const state: FlowState = { name: this.name, step, data, startedAt: Date.now() };
    ctx.session.flow = state;
    await this.steps[step]!.enter(ctx, data);
  }

  private backKb(ctx: BotContext, d: GradeEntryData): InlineKeyboard {
    return new InlineKeyboard().text(ctx.t('btn-back'), this.backTarget(d));
  }

  private backTarget(d: GradeEntryData): string {
    if (d.back) return d.back;
    return d.journalId ? sectionCb('journals', 'j', d.journalId) : sectionCb('journals', 'list');
  }

  private async cancel(ctx: BotContext, d: GradeEntryData): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(ctx, ctx.t('cancel-done'), this.backKb(ctx, d));
    return { stay: true };
  }

  private zone(ctx: BotContext): string {
    return ctx.actor?.account.timezone ?? 'UTC';
  }

  readonly steps: Record<string, FlowStep<GradeEntryData>> = {
    journal: {
      enter: async (ctx, d) => {
        const studentId = d.studentIds?.[d.index];
        if (!ctx.actor || !studentId) {
          ctx.session.flow = undefined;
          await renderMenu(ctx, ctx.t('grade-nobody'), this.backKb(ctx, d));
          return;
        }
        const link = await this.journals.activeLink(ctx.actor.actor.accountId, studentId);
        if (!link) {
          ctx.session.flow = undefined;
          await renderMenu(ctx, ctx.t('grade-link-inactive'), this.backKb(ctx, d));
          return;
        }
        const { journals, student } = await this.query.teacherJournals(ctx.actor.actor, link.id);
        const list = journals.filter(
          (j) => !j.journal.hidden && (!d.subjectId || j.journal.subjectId === d.subjectId),
        );
        const shown = list.length > 0 ? list : journals;
        d.shownJournals = shown.map((j) => j.journal.id);
        const kb = new InlineKeyboard();
        shown.forEach((j, i) => {
          const label = `${j.subject?.name ?? '—'} · ${ctx.t('journal-type', { type: j.journal.type })}`;
          kb.text(clip(label, 40), flowCb('journal', 'pick', i)).row();
        });
        if ((d.studentIds?.length ?? 0) > 1) kb.text(ctx.t('btn-skip-student'), flowCb('journal', 'skip'));
        kb.text(ctx.t('btn-cancel'), flowCb('journal', 'cancel'));
        await renderMenu(
          ctx,
          ctx.t('grade-pick-journal', { student: escapeHtml(cardDisplayName({ link, student })) }),
          kb,
        );
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.cancel(ctx, d);
        if (action === 'skip') return this.next(ctx, d);
        const id = d.shownJournals[Number(args[0])];
        if (action !== 'pick' || !id) return { stay: true };
        const journal = await this.repo.findById(id);
        if (!journal) return { stay: true };
        d.journalId = id;
        d.type = journal.type;
        return { goto: 'value' };
      },
    },
    value: {
      enter: async (ctx, d) => {
        if (!ctx.actor || !d.journalId) return;
        const kb = new InlineKeyboard();
        let text: string;
        if (d.type === 'school') {
          for (let v = 1; v <= 10; v += 1) {
            kb.text(String(v), flowCb('value', 'n', v));
            if (v % 5 === 0) kb.row();
          }
          text = ctx.t('grade-ask-school');
        } else if (d.type === 'custom') {
          const scale = await this.journals.customScale(ctx.actor.actor);
          const live = scale?.values.filter((v) => !v.archivedAt) ?? [];
          if (live.length === 0) {
            ctx.session.flow = undefined;
            await renderMenu(
              ctx,
              ctx.t('grade-no-scale'),
              new InlineKeyboard()
                .text(ctx.t('btn-set-scale'), sectionCb('journals', 'scale'))
                .row()
                .text(ctx.t('btn-back'), this.backTarget(d)),
            );
            return;
          }
          d.shownValues = live.map((v) => v.id);
          live.forEach((v, i) => kb.text(clip(scaleValueLabel(v), 30), flowCb('value', 'sv', i)).row());
          text = ctx.t('grade-ask-custom');
        } else {
          text = ctx.t('grade-ask-test', { max: DEFAULT_TEST_MAX });
        }
        kb.text(ctx.t('btn-cancel'), flowCb('value', 'cancel'));
        await renderMenu(ctx, text, kb);
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.cancel(ctx, d);
        if (action === 'n' && d.type === 'school') {
          d.value = Number(args[0]);
          return { goto: 'kind' };
        }
        if (action === 'sv' && d.type === 'custom') {
          const id = d.shownValues[Number(args[0])];
          if (!id) return { stay: true };
          d.scaleValueId = id;
          return { goto: this.afterValue(d) };
        }
        return { stay: true };
      },
      onText: async (ctx, d, text) => {
        if (d.type === 'custom') {
          await say(ctx, ctx.t('grade-ask-custom'));
          return { stay: true };
        }
        const m = SCORE.exec(text.replace(',', '.'));
        if (!m) {
          await say(ctx, ctx.t('grade-value-invalid'));
          return { stay: true };
        }
        const num = (s: string | undefined) => (s === undefined ? null : Number(s.replace(',', '.')));
        d.value = num(m[1]);
        if (d.type === 'tests') {
          d.max = num(m[2]) ?? DEFAULT_TEST_MAX;
          d.parts = m[3] !== undefined ? { a: num(m[3])!, b: num(m[4])! } : null;
        } else if (!Number.isInteger(d.value) || d.value! < 1 || d.value! > 10) {
          await say(ctx, ctx.t('grade-value-invalid'));
          return { stay: true };
        }
        return { goto: 'kind' };
      },
    },
    kind: {
      enter: async (ctx, d) => {
        const kb = new InlineKeyboard();
        if (d.type === 'school') {
          SCHOOL_CATEGORIES.forEach((c, i) => {
            kb.text(ctx.t('grade-category', { key: c }), flowCb('kind', 'c', i));
            if (i % 2 === 1) kb.row();
          });
        } else if (ctx.actor) {
          const kinds = await this.journals.testKinds(ctx.actor.actor);
          d.shownKinds = kinds.map((k) => k.id);
          kinds.forEach((k, i) => {
            kb.text(k.name, flowCb('kind', 'k', i));
            if (i % 2 === 1) kb.row();
          });
        }
        kb.row().text(ctx.t('btn-cancel'), flowCb('kind', 'cancel'));
        await renderMenu(ctx, ctx.t(d.type === 'school' ? 'grade-ask-category' : 'grade-ask-kind'), kb);
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.cancel(ctx, d);
        if (action === 'c') {
          const c = SCHOOL_CATEGORIES[Number(args[0])];
          if (!c) return { stay: true };
          d.category = c;
          return { goto: this.afterKind(d) };
        }
        if (action === 'k') {
          const id = d.shownKinds[Number(args[0])];
          if (!id) return { stay: true };
          d.testKindId = id;
          return { goto: this.afterKind(d) };
        }
        return { stay: true };
      },
    },
    date: {
      enter: async (ctx) => {
        const zone = this.zone(ctx);
        const today = DateTime.fromJSDate(this.clock.now(), { zone });
        const kb = new InlineKeyboard()
          .text(ctx.t('btn-day-today'), flowCb('date', 'd', today.toISODate()!))
          .text(ctx.t('btn-day-yesterday'), flowCb('date', 'd', today.minus({ days: 1 }).toISODate()!))
          .row()
          .text(ctx.t('btn-cancel'), flowCb('date', 'cancel'));
        await renderMenu(ctx, ctx.t('grade-ask-date'), kb);
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.cancel(ctx, d);
        if (action === 'd' && args[0]) {
          d.date = args[0];
          return { goto: 'comment' };
        }
        return { stay: true };
      },
      onText: async (ctx, d, text) => {
        const today = DateTime.fromJSDate(this.clock.now(), { zone: this.zone(ctx) }).toISODate()!;
        // marks are dated in the past: a day-month that the schedule parser pushes to next year means last year
        let iso = parseDayInput(text, this.zone(ctx), this.clock.now());
        if (iso && iso > today && !/\d{4}|\d{2}$/.test(text.trim().split(/[.\-/]/)[2] ?? ''))
          iso = DateTime.fromISO(iso).minus({ years: 1 }).toISODate();
        if (!iso || iso > today) {
          await say(ctx, ctx.t('grade-date-invalid'));
          return { stay: true };
        }
        d.date = iso;
        return { goto: 'comment' };
      },
    },
    comment: {
      enter: async (ctx) =>
        renderMenu(
          ctx,
          ctx.t('grade-ask-comment'),
          new InlineKeyboard()
            .text(ctx.t('btn-skip'), flowCb('comment', 'skip'))
            .text(ctx.t('btn-cancel'), flowCb('comment', 'cancel')),
        ),
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.cancel(ctx, d);
        return action === 'skip' ? { done: true } : { stay: true };
      },
      onText: async (ctx, d, text) => {
        if (text.length > MAX_ENTRY_COMMENT_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_ENTRY_COMMENT_LENGTH }));
          return { stay: true };
        }
        d.comment = text.trim() || null;
        return { done: true };
      },
    },
  };

  /** Editing keeps the date; a lesson record is dated by the lesson's day (preset): no date step then. */
  private afterKind(d: GradeEntryData): string {
    return d.entryId || d.date ? 'comment' : 'date';
  }

  private afterValue(d: GradeEntryData): string {
    return d.type === 'custom' ? this.afterKind(d) : 'kind';
  }

  /** Group lessons: the next participant, or the summary. */
  private async next(ctx: BotContext, d: GradeEntryData): Promise<FlowNext> {
    d.index += 1;
    d.journalId = undefined;
    d.type = null;
    d.value = null;
    d.max = null;
    d.parts = null;
    d.scaleValueId = null;
    d.category = null;
    d.testKindId = null;
    d.comment = null;
    if (d.studentIds && d.index < d.studentIds.length) return { goto: 'journal' };
    ctx.session.flow = undefined;
    await renderMenu(ctx, ctx.t('grade-saved-many', { count: d.saved }), this.backKb(ctx, d));
    return { stay: true };
  }

  async complete(ctx: BotContext, d: GradeEntryData): Promise<void | { goto: string }> {
    if (!ctx.actor || !d.journalId) return;
    const actor = ctx.actor.actor;
    const values = {
      value: d.value,
      max: d.max,
      parts: d.parts,
      scaleValueId: d.scaleValueId,
      category: d.category,
      testKindId: d.testKindId,
      comment: d.comment,
    };
    try {
      if (d.entryId) await this.entries.update(actor, d.entryId, values);
      else
        await this.entries.add(actor, {
          journalId: d.journalId,
          date: d.date,
          lessonId: d.lessonId ?? null,
          assignmentId: d.assignmentId ?? null,
          ...values,
        });
    } catch (error) {
      if (AppError.is(error, 'VALIDATION_ERROR')) {
        await say(ctx, ctx.t('grade-value-invalid'));
        return { goto: 'value' };
      }
      if (isTerminalFlowError(error)) ctx.session.flow = undefined;
      throw error;
    }
    d.saved += 1;
    if (d.studentIds && d.studentIds.length > 1 && !d.entryId) {
      // keep the dialog alive for the next participant: `next` either re-enters «journal» or finishes
      const state = ctx.session.flow;
      const result = await this.next(ctx, d);
      if ('goto' in result && state) {
        ctx.session.flow = state;
        return { goto: result.goto };
      }
      return;
    }
    await renderMenu(ctx, ctx.t(d.entryId ? 'grade-updated' : 'grade-saved'), this.backKb(ctx, d));
  }
}
