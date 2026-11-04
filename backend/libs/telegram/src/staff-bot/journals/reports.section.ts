import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { DateTime } from 'luxon';
import { AppError } from '@shared/errors/app-error.js';
import { isUuid } from '@shared/ids/index.js';
import type { Actor } from '@modules/access/actor.js';
import { renderReport } from '@modules/gradebook/report-text.js';
import { ReportsUseCase, type ReportView } from '@modules/gradebook/reports.use-case.js';
import { cardDisplayName, TeacherStudentsQuery } from '@modules/people/links/students.query.js';
import type { CreatedBot } from '../../core/bot-factory.js';
import type { BotContext } from '../../core/context.js';
import { escapeHtml, renderMenu, say } from '../../core/ui.js';
import { sectionCb, type StaffSectionModule } from '../section-module.js';
import { ReportFlow } from './report.flow.js';

const DATE = 'dd.MM.yyyy';

/**
 * StaffBot → Журналы → ученик → 📄 Отчёт (UC-31, 5.12): past reports of the student (drafts and sent), a new
 * report through the dialog, sending a saved draft. Reached by buttons only (`s:reports:*`).
 */
@Injectable()
export class ReportsSection implements StaffSectionModule {
  readonly section = 'reports' as const;

  constructor(
    private readonly reports: ReportsUseCase,
    private readonly students: TeacherStudentsQuery,
    private readonly flow: ReportFlow,
  ) {}

  register({ flows }: CreatedBot): void {
    flows.register(this.flow);
  }

  async open(ctx: BotContext, _actor: Actor): Promise<void> {
    await renderMenu(
      ctx,
      ctx.t('journals-root-empty', { pending: 0 }),
      new InlineKeyboard().text(ctx.t('btn-back'), 'm:open:journals'),
    );
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    const id = args[0];
    switch (action) {
      case 'list':
        return isUuid(id) ? this.list(ctx, actor, id) : this.open(ctx, actor);
      case 'new': // from the student's journals screen
        return isUuid(id) ? this.flow.start(ctx, { linkId: id }) : this.open(ctx, actor);
      case 'r':
        return isUuid(id) ? this.report(ctx, actor, id) : this.open(ctx, actor);
      case 'send':
        return isUuid(id) ? this.send(ctx, actor, id) : this.open(ctx, actor);
      default:
        return this.open(ctx, actor);
    }
  }

  private async list(ctx: BotContext, actor: Actor, linkId: string): Promise<void> {
    let items: ReportView[];
    const card = await this.students.card(actor.accountId, linkId);
    if (!card) return this.open(ctx, actor);
    try {
      items = await this.reports.listForTeacher(actor, linkId);
    } catch (error) {
      if (
        !AppError.is(error, 'NOT_FOUND') &&
        !AppError.is(error, 'LINK_NOT_ACTIVE') &&
        !AppError.is(error, 'FEATURE_DISABLED')
      )
        throw error;
      return this.open(ctx, actor);
    }
    const kb = new InlineKeyboard();
    for (const v of items)
      kb.text(
        ctx.t('report-line', {
          status: v.report.status,
          from: DateTime.fromISO(v.report.periodFrom).toFormat(DATE),
          to: DateTime.fromISO(v.report.periodTo).toFormat(DATE),
        }),
        sectionCb('reports', 'r', v.report.id),
      ).row();
    if (card.link.status === 'active')
      kb.text(ctx.t('btn-report-new'), sectionCb('reports', 'new', linkId)).row();
    kb.text(ctx.t('btn-back'), sectionCb('journals', 'st', linkId));
    await renderMenu(
      ctx,
      ctx.t(items.length > 0 ? 'reports-list' : 'reports-list-empty', {
        student: escapeHtml(cardDisplayName(card)),
      }),
      kb,
    );
  }

  private async report(ctx: BotContext, actor: Actor, reportId: string): Promise<void> {
    let view: ReportView;
    try {
      view = await this.reports.teacherReport(actor, reportId);
    } catch (error) {
      if (!AppError.is(error, 'NOT_FOUND')) throw error;
      return this.open(ctx, actor);
    }
    const zone = ctx.actor?.account.timezone ?? 'UTC';
    const kb = new InlineKeyboard();
    if (view.report.status === 'draft')
      kb.text(ctx.t('btn-report-send'), sectionCb('reports', 'send', reportId)).row();
    kb.text(ctx.t('btn-back'), sectionCb('reports', 'list', view.report.teacherStudentId));
    const when = view.report.sentAt ?? view.report.createdAt;
    await renderMenu(
      ctx,
      ctx.t('report-card', {
        body: renderReport((k, v) => ctx.t(k, v), view.snapshot, view.report.comment),
        status: view.report.status,
        when: DateTime.fromJSDate(when, { zone }).toFormat('dd.MM.yyyy HH:mm'),
      }),
      kb,
    );
  }

  private async send(ctx: BotContext, actor: Actor, reportId: string): Promise<void> {
    try {
      await this.reports.send(actor, reportId);
      await say(ctx, ctx.t('report-sent-done'));
    } catch (error) {
      if (AppError.is(error, 'CONFLICT')) await say(ctx, ctx.t('report-already-sent'));
      else if (AppError.is(error, 'NOT_FOUND')) return this.open(ctx, actor);
      else if (AppError.is(error, 'LINK_NOT_ACTIVE')) await say(ctx, ctx.t('grade-link-inactive'));
      else throw error;
    }
    return this.report(ctx, actor, reportId);
  }
}
