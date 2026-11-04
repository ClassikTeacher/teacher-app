import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { DateTime } from 'luxon';
import { AppError } from '@shared/errors/app-error.js';
import { isUuid } from '@shared/ids/index.js';
import type { Actor } from '@modules/access/actor.js';
import {
  GradebookQuery,
  type JournalCard,
  type TeacherJournalsGroup,
} from '@modules/gradebook/gradebook.query.js';
import { renderReport } from '@modules/gradebook/report-text.js';
import { ReportsUseCase, type ReportView } from '@modules/gradebook/reports.use-case.js';
import type { AccountRow } from '@modules/identity/schema.js';
import { cb } from '../core/callback.js';
import type { BotContext } from '../core/context.js';
import { clip, fullName } from '../core/format.js';
import { SECTION_NS } from '../core/sections.js';
import { escapeHtml, renderMenu } from '../core/ui.js';
import { entryLine, periodLabel, statsText } from './journal-format.js';
import { ProposeGradeFlow } from './propose-grade.flow.js';

const DATE = 'dd.MM.yyyy';

/** Who looks: the student themself, or a parent at a child. */
export interface ProgressSubject {
  side: 'student' | 'parent';
  child: AccountRow | null;
}

/**
 * «📊 Успеваемость» shared by StudentBot and ParentBot (UC-36, 5.11, 5.12): journals grouped by teacher (only
 * the ones made visible, JRN-04; archive links read-only), the journal screen with statistics and records,
 * «Сообщить отметку» for a school journal (UC-30), sent reports. Callbacks are `s:<section>:<action>`.
 */
@Injectable()
export class ProgressScreen {
  constructor(
    private readonly query: GradebookQuery,
    private readonly reportsUseCase: ReportsUseCase,
    private readonly propose: ProposeGradeFlow,
  ) {}

  get flow(): ProposeGradeFlow {
    return this.propose;
  }

  async root(ctx: BotContext, actor: Actor, section: string, who: ProgressSubject): Promise<void> {
    const c = (a: string, ...rest: Array<string | number>) => cb(SECTION_NS, section, a, ...rest);
    let groups: TeacherJournalsGroup[];
    try {
      groups =
        who.side === 'student'
          ? await this.query.forStudent(actor)
          : await this.query.forChild(actor, who.child!.id);
    } catch (error) {
      if (!AppError.is(error, 'NOT_FOUND') && !AppError.is(error, 'FORBIDDEN')) throw error;
      groups = [];
    }
    const kb = new InlineKeyboard();
    const lines: string[] = [];
    for (const g of groups) {
      const mark = g.view === 'archive' ? '🗂 ' : '';
      lines.push(`${mark}<b>${escapeHtml(fullName(g.teacher))}</b>`);
      for (const j of g.journals) {
        const label = `${j.subject?.name ?? '—'} · ${ctx.t('journal-type-person', { type: j.journal.type })} (${j.count})`;
        kb.text(clip(`${mark}${label}`, 40), c('j', j.journal.id)).row();
      }
    }
    kb.text(ctx.t('btn-progress-reports'), c('reports')).row();
    kb.text(ctx.t('btn-back'), 'm:main');
    const child = who.child ? escapeHtml(fullName(who.child)) : '';
    await renderMenu(
      ctx,
      ctx.t(groups.length > 0 ? 'progress-root' : 'progress-root-empty', {
        teachers: lines.join('\n'),
        child,
        side: who.side,
      }),
      kb,
    );
  }

  async journal(
    ctx: BotContext,
    actor: Actor,
    section: string,
    who: ProgressSubject,
    journalId: string,
  ): Promise<void> {
    const c = (a: string, ...rest: Array<string | number>) => cb(SECTION_NS, section, a, ...rest);
    if (!isUuid(journalId)) return this.root(ctx, actor, section, who);
    let card: JournalCard;
    try {
      card = await this.query.personCard(actor, journalId);
    } catch (error) {
      if (!AppError.is(error, 'NOT_FOUND')) throw error;
      return this.root(ctx, actor, section, who);
    }
    // 8.0: a parent sees only the selected child's journal through this screen
    if (who.side === 'parent' && who.child && card.student.id !== who.child.id)
      return this.root(ctx, actor, section, who);
    const kb = new InlineKeyboard();
    if (card.journal.type === 'school' && card.link.status === 'active' && card.teacher.status === 'active')
      kb.text(ctx.t('btn-propose-grade'), c('propose', journalId)).row();
    kb.text(ctx.t('btn-back'), c('list'));
    const lines = card.entries
      .slice()
      .reverse()
      .map((e) => entryLine(ctx, card, e))
      .join('\n');
    await renderMenu(
      ctx,
      ctx.t('progress-journal', {
        teacher: escapeHtml(fullName(card.teacher)),
        subject: escapeHtml(card.subject?.name ?? '—'),
        type: card.journal.type,
        period: periodLabel(ctx, card),
        stats: statsText(ctx, card),
        entries: lines || ctx.t('journal-no-entries'),
        childLine: who.child ? ` · ${escapeHtml(fullName(who.child))}` : '',
      }),
      kb,
    );
  }

  async startPropose(
    ctx: BotContext,
    actor: Actor,
    section: string,
    who: ProgressSubject,
    journalId: string,
  ): Promise<void> {
    if (!isUuid(journalId)) return this.root(ctx, actor, section, who);
    await this.propose.start(ctx, {
      journalId,
      studentId: who.side === 'parent' ? who.child?.id : undefined,
      back: cb(SECTION_NS, section, 'j', journalId),
    });
  }

  async reports(ctx: BotContext, actor: Actor, section: string, who: ProgressSubject): Promise<void> {
    const c = (a: string, ...rest: Array<string | number>) => cb(SECTION_NS, section, a, ...rest);
    let items: ReportView[];
    try {
      items =
        who.side === 'student'
          ? await this.reportsUseCase.listForStudent(actor)
          : await this.reportsUseCase.listForChild(actor, who.child!.id);
    } catch (error) {
      if (!AppError.is(error, 'NOT_FOUND') && !AppError.is(error, 'FORBIDDEN')) throw error;
      items = [];
    }
    const kb = new InlineKeyboard();
    for (const v of items.slice(0, 20))
      kb.text(
        clip(
          `📄 ${DateTime.fromISO(v.report.periodFrom).toFormat(DATE)} — ${DateTime.fromISO(v.report.periodTo).toFormat(DATE)} · ${v.teacher ? fullName(v.teacher) : '—'}`,
          40,
        ),
        c('r', v.report.id),
      ).row();
    kb.text(ctx.t('btn-back'), c('list'));
    await renderMenu(ctx, ctx.t(items.length > 0 ? 'progress-reports' : 'progress-reports-empty'), kb);
  }

  async report(
    ctx: BotContext,
    actor: Actor,
    section: string,
    who: ProgressSubject,
    reportId: string,
  ): Promise<void> {
    const c = (a: string, ...rest: Array<string | number>) => cb(SECTION_NS, section, a, ...rest);
    if (!isUuid(reportId)) return this.reports(ctx, actor, section, who);
    let view: ReportView;
    try {
      view = await this.reportsUseCase.personReport(actor, reportId);
    } catch (error) {
      if (!AppError.is(error, 'NOT_FOUND')) throw error;
      return this.reports(ctx, actor, section, who);
    }
    await renderMenu(
      ctx,
      renderReport((k, v) => ctx.t(k, v), view.snapshot, view.report.comment),
      new InlineKeyboard().text(ctx.t('btn-back'), c('reports')),
    );
  }
}
