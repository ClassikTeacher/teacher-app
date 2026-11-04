import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { DateTime } from 'luxon';
import { AppError } from '@shared/errors/app-error.js';
import { isUuid } from '@shared/ids/index.js';
import { Clock } from '@shared/time/clock.js';
import type { Actor } from '@modules/access/actor.js';
import { entryKindText, entryValueText } from '@modules/gradebook/format.js';
import { GradeEntriesUseCase } from '@modules/gradebook/grade-entries.use-case.js';
import { GradeEntryRepository } from '@modules/gradebook/grade-entry.repository.js';
import { type JournalCard, GradebookQuery } from '@modules/gradebook/gradebook.query.js';
import { scaleValueLabel } from '@modules/gradebook/gradebook.rules.js';
import { JournalsUseCase } from '@modules/gradebook/journals.use-case.js';
import type { GradeEntryRow } from '@modules/gradebook/schema.js';
import type { Range } from '@modules/gradebook/stats.js';
import { FileDeliveryService } from '@modules/files/file-delivery.service.js';
import { FileRepository } from '@modules/files/file.repository.js';
import { HomeworkQuery } from '@modules/homework/homework.query.js';
import { cardDisplayName, TeacherStudentsQuery } from '@modules/people/links/students.query.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { LessonsQuery } from '@modules/schedule/lessons/lessons.query.js';
import type { CreatedBot } from '../../core/bot-factory.js';
import type { BotContext } from '../../core/context.js';
import { clip, fullName } from '../../core/format.js';
import { escapeHtml, renderMenu, say } from '../../core/ui.js';
import { sectionCb, type StaffSectionModule } from '../section-module.js';
import { entryButton, entryLine, periodLabel, statsText } from '../../person/journal-format.js';
import { GradeEntryFlow } from './grade-entry.flow.js';
import { JournalTextFlow } from './journal-text.flow.js';

const ENTRY_BUTTONS = 5;
const DATE = 'dd.MM';

/** Period keys of the journal screen: all records, this month, the previous month. */
type PeriodKey = 'a' | 'm' | 'p';

/**
 * StaffBot → 📊 Журналы и отчёты (UC-29, 5.11): students → their journals → the journal screen with statistics
 * and the last records, adding and editing records, visibility (JRN-04), proposed marks (UC-30), the custom
 * scale (5.11.4), test kinds (5.11.3). Entry points from the lesson report and the submission card (5.6.4, 5.10.4).
 */
@Injectable()
export class JournalsSection implements StaffSectionModule {
  readonly section = 'journals' as const;

  constructor(
    private readonly query: GradebookQuery,
    private readonly entries: GradeEntriesUseCase,
    private readonly journals: JournalsUseCase,
    private readonly entryRepo: GradeEntryRepository,
    private readonly students: TeacherStudentsQuery,
    private readonly profiles: TeacherProfileRepository,
    private readonly lessons: LessonsQuery,
    private readonly homework: HomeworkQuery,
    private readonly files: FileRepository,
    private readonly delivery: FileDeliveryService,
    private readonly entryFlow: GradeEntryFlow,
    private readonly textFlow: JournalTextFlow,
    private readonly clock: Clock,
  ) {}

  register({ flows }: CreatedBot): void {
    flows.register(this.entryFlow).register(this.textFlow);
  }

  async open(ctx: BotContext, actor: Actor): Promise<void> {
    const [items, pending, profile] = await Promise.all([
      this.students.listActive(actor.accountId),
      this.query.countPending(actor.accountId),
      this.profiles.find(actor.accountId),
    ]);
    const kb = new InlineKeyboard();
    for (const item of items.slice(0, 20))
      kb.text(clip(cardDisplayName(item)), sectionCb('journals', 'st', item.link.id)).row();
    if (pending > 0)
      kb.text(ctx.t('btn-grades-pending', { count: pending }), sectionCb('journals', 'pending')).row();
    kb.text(ctx.t('btn-set-scale'), sectionCb('journals', 'scale'))
      .text(ctx.t('btn-test-kinds'), sectionCb('journals', 'kinds'))
      .row()
      .text(
        ctx.t('btn-grade-auto', { state: profile?.gradeAutoConfirm ? '☑️' : '⬜' }),
        sectionCb('journals', 'auto'),
      )
      .row()
      .text(ctx.t('btn-back'), 'm:main');
    await renderMenu(ctx, ctx.t(items.length > 0 ? 'journals-root' : 'journals-root-empty', { pending }), kb);
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    const id = args[0];
    switch (action) {
      case 'list':
        return this.open(ctx, actor);
      case 'st':
        return isUuid(id) ? this.student(ctx, actor, id) : this.open(ctx, actor);
      case 'j':
        return isUuid(id) ? this.journal(ctx, actor, id, this.period(ctx, args[1])) : this.open(ctx, actor);
      case 'add':
        return isUuid(id) ? this.entryFlow.start(ctx, { journalId: id }) : this.open(ctx, actor);
      case 'e':
        return isUuid(id) ? this.entry(ctx, actor, id) : this.open(ctx, actor);
      case 'edit':
        return isUuid(id) ? this.edit(ctx, actor, id) : this.open(ctx, actor);
      case 'del':
        return isUuid(id) ? this.confirmDelete(ctx, actor, id) : this.open(ctx, actor);
      case 'delok':
        return isUuid(id) ? this.remove(ctx, actor, id) : this.open(ctx, actor);
      case 'vs':
      case 'vp':
      case 'hd':
        return isUuid(id) ? this.toggle(ctx, actor, id, action) : this.open(ctx, actor);
      case 'tg':
        return isUuid(id)
          ? this.textFlow.start(ctx, { kind: 'target', journalId: id })
          : this.open(ctx, actor);
      case 'pending':
        return this.pending(ctx, actor);
      case 'ok':
      case 'no':
        return isUuid(id) ? this.decide(ctx, actor, id, action === 'ok') : this.open(ctx, actor);
      case 'scale':
        return this.scale(ctx, actor);
      case 'scaleset':
        return this.textFlow.start(ctx, { kind: 'scale' });
      case 'sv':
        return isUuid(id) ? this.archiveValue(ctx, actor, id) : this.scale(ctx, actor);
      case 'kinds':
        return this.kinds(ctx, actor);
      case 'kindadd':
        return this.textFlow.start(ctx, { kind: 'test-kind' });
      case 'kd':
        return isUuid(id) ? this.removeKind(ctx, actor, id) : this.kinds(ctx, actor);
      case 'auto':
        await this.journals.toggleAutoConfirm(actor);
        return this.open(ctx, actor);
      case 'lesson': // s:journals:lesson:<lessonId> — marks for the participants (5.6.4 «отметки»)
        return isUuid(id) ? this.gradeLesson(ctx, actor, id) : this.open(ctx, actor);
      case 'grade': // s:journals:grade:<submissionId> — «⭐ Оценить» on the submission card (5.10.4)
        return isUuid(id) ? this.gradeSubmission(ctx, actor, id) : this.open(ctx, actor);
      default:
        return this.open(ctx, actor);
    }
  }

  private period(ctx: BotContext, key: string | undefined): Range | null {
    const zone = ctx.actor?.account.timezone ?? 'UTC';
    const now = DateTime.fromJSDate(this.clock.now(), { zone });
    const k = (key ?? 'a') as PeriodKey;
    if (k === 'm') return { from: now.startOf('month').toISODate()!, to: now.endOf('month').toISODate()! };
    if (k === 'p') {
      const prev = now.minus({ months: 1 });
      return { from: prev.startOf('month').toISODate()!, to: prev.endOf('month').toISODate()! };
    }
    return null;
  }

  // --- screens ------------------------------------------------------------------------------------

  private async student(ctx: BotContext, actor: Actor, linkId: string): Promise<void> {
    let view;
    try {
      view = await this.query.teacherJournals(actor, linkId);
    } catch (error) {
      if (!AppError.is(error, 'NOT_FOUND')) throw error;
      return this.open(ctx, actor);
    }
    const kb = new InlineKeyboard();
    for (const j of view.journals) {
      const mark = j.journal.hidden ? '🙈 ' : '';
      const label = `${mark}${j.subject?.name ?? '—'} · ${ctx.t('journal-type', { type: j.journal.type })} (${j.count})`;
      kb.text(clip(label, 40), sectionCb('journals', 'j', j.journal.id)).row();
    }
    kb.text(ctx.t('btn-report'), sectionCb('reports', 'list', linkId)).row();
    kb.text(ctx.t('btn-back'), sectionCb('journals', 'list'));
    await renderMenu(
      ctx,
      ctx.t('journals-student', {
        student: escapeHtml(cardDisplayName({ link: view.link, student: view.student })),
      }),
      kb,
    );
  }

  private async journal(
    ctx: BotContext,
    actor: Actor,
    journalId: string,
    range: Range | null,
  ): Promise<void> {
    let card: JournalCard;
    try {
      card = await this.query.teacherCard(actor, journalId, range);
    } catch (error) {
      if (!AppError.is(error, 'NOT_FOUND') && !AppError.is(error, 'FEATURE_DISABLED')) throw error;
      return this.open(ctx, actor);
    }
    const kb = new InlineKeyboard();
    if (card.link.status === 'active')
      kb.text(ctx.t('btn-grade-add'), sectionCb('journals', 'add', journalId));
    if (card.pending.length > 0)
      kb.text(ctx.t('btn-grades-pending', { count: card.pending.length }), sectionCb('journals', 'pending'));
    kb.row();
    for (const e of card.entries.slice(-ENTRY_BUTTONS).reverse())
      kb.text(entryButton(card, e), sectionCb('journals', 'e', e.id)).row();
    const periodKey = !range ? 'a' : range.from === this.period(ctx, 'm')?.from ? 'm' : 'p';
    for (const k of ['a', 'm', 'p'] as const)
      kb.text(
        `${k === periodKey ? '• ' : ''}${ctx.t(`journal-period-${k}`)}`,
        sectionCb('journals', 'j', journalId, k),
      );
    kb.row();
    kb.text(
      ctx.t('btn-vis-student', { state: card.journal.visibleToStudent ? '☑️' : '⬜' }),
      sectionCb('journals', 'vs', journalId),
    )
      .text(
        ctx.t('btn-vis-parent', { state: card.journal.visibleToParent ? '☑️' : '⬜' }),
        sectionCb('journals', 'vp', journalId),
      )
      .row();
    kb.text(
      ctx.t(card.journal.hidden ? 'btn-journal-unhide' : 'btn-journal-hide'),
      sectionCb('journals', 'hd', journalId),
    );
    if (card.journal.type === 'tests') kb.text(ctx.t('btn-target'), sectionCb('journals', 'tg', journalId));
    kb.row().text(ctx.t('btn-back'), sectionCb('journals', 'st', card.link.id));
    const lines = card.entries
      .slice()
      .reverse()
      .map((e) => entryLine(ctx, card, e))
      .join('\n');
    await renderMenu(
      ctx,
      ctx.t('journal-card', {
        student: escapeHtml(cardDisplayName({ link: card.link, student: card.student })),
        subject: escapeHtml(card.subject?.name ?? '—'),
        type: card.journal.type,
        period: periodLabel(ctx, card),
        stats: statsText(ctx, card),
        entries: lines || ctx.t('journal-no-entries'),
        hidden: card.journal.hidden ? 'yes' : 'no',
      }),
      kb,
    );
  }

  /** The teacher's own record or null (8.0). */
  private async ownEntry(actor: Actor, entryId: string): Promise<GradeEntryRow | null> {
    const entry = await this.entryRepo.findById(entryId);
    return entry && entry.teacherId === actor.accountId && !entry.deletedAt ? entry : null;
  }

  private async entry(ctx: BotContext, actor: Actor, entryId: string): Promise<void> {
    const entry = await this.ownEntry(actor, entryId);
    if (!entry) return this.open(ctx, actor);
    const card = await this.query.teacherCard(actor, entry.journalId);
    const kb = new InlineKeyboard();
    if (entry.status === 'pending')
      kb.text(ctx.t('btn-grade-confirm'), sectionCb('journals', 'ok', entry.id))
        .text(ctx.t('btn-grade-reject'), sectionCb('journals', 'no', entry.id))
        .row();
    else if (card.link.status === 'active')
      kb.text(ctx.t('btn-grade-edit'), sectionCb('journals', 'edit', entry.id))
        .text(ctx.t('btn-grade-delete'), sectionCb('journals', 'del', entry.id))
        .row();
    kb.text(ctx.t('btn-back'), sectionCb('journals', 'j', entry.journalId));
    const kindRaw = entryKindText(entry, card.journal.type, card.lookups);
    await renderMenu(
      ctx,
      ctx.t('grade-entry-card', {
        student: escapeHtml(cardDisplayName({ link: card.link, student: card.student })),
        subject: escapeHtml(card.subject?.name ?? '—'),
        type: card.journal.type,
        value: escapeHtml(entryValueText(entry, card.journal.type, card.lookups)),
        kind:
          card.journal.type === 'school'
            ? ctx.t('grade-category', { key: kindRaw ?? 'current' })
            : escapeHtml(kindRaw ?? '—'),
        date: DateTime.fromISO(entry.date).toFormat(DATE),
        comment: entry.comment ? escapeHtml(entry.comment) : '—',
        source: entry.source,
        status: entry.status,
      }),
      kb,
    );
    // 5.11.3: the scanned sheet follows the card as a document (withheld until the antivirus check)
    if (entry.fileId && ctx.chat) {
      const file = await this.files.findById(entry.fileId);
      if (file && file.status !== 'deleted') {
        const report = await this.delivery.sendMany(ctx.api, 'staff', ctx.chat.id, [file]);
        if (report.skipped.length > 0) await say(ctx, ctx.t('smat-file-pending'));
      }
    }
  }

  private async edit(ctx: BotContext, actor: Actor, entryId: string): Promise<void> {
    const entry = await this.ownEntry(actor, entryId);
    if (!entry || entry.status !== 'confirmed') return this.open(ctx, actor);
    await this.entryFlow.start(ctx, {
      entryId: entry.id,
      journalId: entry.journalId,
      back: sectionCb('journals', 'e', entry.id),
    });
  }

  private async confirmDelete(ctx: BotContext, actor: Actor, entryId: string): Promise<void> {
    const entry = await this.ownEntry(actor, entryId);
    if (!entry) return this.open(ctx, actor);
    await renderMenu(
      ctx,
      ctx.t('grade-delete-confirm'),
      new InlineKeyboard()
        .text(ctx.t('btn-yes'), sectionCb('journals', 'delok', entry.id))
        .text(ctx.t('btn-no'), sectionCb('journals', 'e', entry.id)),
    );
  }

  private async remove(ctx: BotContext, actor: Actor, entryId: string): Promise<void> {
    const entry = await this.ownEntry(actor, entryId);
    if (!entry) return this.open(ctx, actor);
    try {
      await this.entries.remove(actor, entryId);
    } catch (error) {
      if (!AppError.is(error, 'NOT_FOUND') && !AppError.is(error, 'LINK_NOT_ACTIVE')) throw error;
      await say(ctx, ctx.t('callback-stale'));
    }
    return this.journal(ctx, actor, entry.journalId, null);
  }

  private async toggle(
    ctx: BotContext,
    actor: Actor,
    journalId: string,
    action: 'vs' | 'vp' | 'hd',
  ): Promise<void> {
    const flag = { vs: 'visibleToStudent', vp: 'visibleToParent', hd: 'hidden' } as const;
    try {
      await this.journals.toggle(actor, journalId, flag[action]);
    } catch (error) {
      if (!AppError.is(error, 'NOT_FOUND')) throw error;
      return this.open(ctx, actor);
    }
    return this.journal(ctx, actor, journalId, null);
  }

  private async pending(ctx: BotContext, actor: Actor): Promise<void> {
    const items = await this.query.pending(actor);
    const kb = new InlineKeyboard();
    for (const it of items.slice(0, 20)) {
      const who = it.student ? fullName(it.student) : '—';
      kb.text(
        clip(
          `${DateTime.fromISO(it.entry.date).toFormat(DATE)} ${who} · ${it.entry.valueNumeric ?? ''} · ${it.subject?.name ?? ''}`,
          40,
        ),
        sectionCb('journals', 'e', it.entry.id),
      ).row();
    }
    kb.text(ctx.t('btn-back'), sectionCb('journals', 'list'));
    await renderMenu(ctx, ctx.t(items.length > 0 ? 'grades-pending' : 'grades-pending-empty'), kb);
  }

  /** Also the buttons of `grade.proposed` (T-14): a stale or foreign id answers «кнопка устарела». */
  private async decide(ctx: BotContext, actor: Actor, entryId: string, ok: boolean): Promise<void> {
    try {
      const entry = ok
        ? await this.entries.confirm(actor, entryId)
        : await this.entries.reject(actor, entryId);
      await say(ctx, ctx.t(ok ? 'grade-confirmed' : 'grade-rejected'));
      return this.journal(ctx, actor, entry.journalId, null);
    } catch (error) {
      if (
        !AppError.is(error, 'NOT_FOUND') &&
        !AppError.is(error, 'CONFLICT') &&
        !AppError.is(error, 'LINK_NOT_ACTIVE')
      )
        throw error;
      await say(ctx, ctx.t('callback-stale'));
      return this.pending(ctx, actor);
    }
  }

  private async scale(ctx: BotContext, actor: Actor): Promise<void> {
    const view = await this.journals.customScale(actor);
    const live = view?.values.filter((v) => !v.archivedAt) ?? [];
    const kb = new InlineKeyboard();
    for (const v of live)
      kb.text(`🙈 ${clip(scaleValueLabel(v), 30)}`, sectionCb('journals', 'sv', v.id)).row();
    kb.text(ctx.t('btn-scale-set'), sectionCb('journals', 'scaleset')).row();
    kb.text(ctx.t('btn-back'), sectionCb('journals', 'list'));
    const lines = live
      .map((v) => `${escapeHtml(scaleValueLabel(v))}${v.weight === null ? '' : ` (${v.weight})`}`)
      .join('\n');
    await renderMenu(
      ctx,
      ctx.t(live.length > 0 ? 'journal-scale' : 'journal-scale-empty', {
        title: escapeHtml(view?.scale.title ?? ''),
        values: lines,
      }),
      kb,
    );
  }

  private async archiveValue(ctx: BotContext, actor: Actor, valueId: string): Promise<void> {
    try {
      await this.journals.archiveScaleValue(actor, valueId);
    } catch (error) {
      if (AppError.is(error, 'VALIDATION_ERROR')) await say(ctx, ctx.t('journal-scale-min'));
      else if (!AppError.is(error, 'NOT_FOUND')) throw error;
    }
    return this.scale(ctx, actor);
  }

  private async kinds(ctx: BotContext, actor: Actor): Promise<void> {
    const kinds = await this.journals.testKinds(actor);
    const kb = new InlineKeyboard();
    for (const k of kinds.filter((x) => x.ownerId === actor.accountId))
      kb.text(`🗑 ${clip(k.name, 30)}`, sectionCb('journals', 'kd', k.id)).row();
    kb.text(ctx.t('btn-kind-add'), sectionCb('journals', 'kindadd')).row();
    kb.text(ctx.t('btn-back'), sectionCb('journals', 'list'));
    await renderMenu(
      ctx,
      ctx.t('journal-kinds', { kinds: escapeHtml(kinds.map((k) => k.name).join(', ')) }),
      kb,
    );
  }

  private async removeKind(ctx: BotContext, actor: Actor, kindId: string): Promise<void> {
    try {
      await this.journals.removeTestKind(actor, kindId);
    } catch (error) {
      if (!AppError.is(error, 'NOT_FOUND')) throw error;
    }
    return this.kinds(ctx, actor);
  }

  // --- entry points from other sections ---------------------------------------------------------------

  private async gradeLesson(ctx: BotContext, actor: Actor, lessonId: string): Promise<void> {
    let view;
    try {
      view = await this.lessons.teacherLesson(actor.accountId, lessonId);
    } catch (error) {
      if (!AppError.is(error, 'NOT_FOUND')) throw error;
      return this.open(ctx, actor);
    }
    const zone = ctx.actor?.account.timezone ?? 'UTC';
    await this.entryFlow.start(ctx, {
      studentIds: view.participants.map((p) => p.student.id),
      subjectId: view.lesson.subjectId,
      lessonId,
      date: DateTime.fromJSDate(view.lesson.startsAt, { zone }).toISODate(),
      back: sectionCb('today', 'lesson', lessonId),
    });
  }

  private async gradeSubmission(ctx: BotContext, actor: Actor, submissionId: string): Promise<void> {
    let card;
    try {
      card = await this.homework.submissionCard(actor.accountId, submissionId);
    } catch (error) {
      if (!AppError.is(error, 'NOT_FOUND')) throw error;
      return this.open(ctx, actor);
    }
    const lessonId = card.assignment.assignedLessonId ?? card.assignment.checkLessonId ?? null;
    let subjectId: string | null = null;
    if (lessonId) {
      try {
        subjectId = (await this.lessons.teacherLesson(actor.accountId, lessonId)).lesson.subjectId;
      } catch (error) {
        if (!AppError.is(error, 'NOT_FOUND')) throw error;
      }
    }
    await this.entryFlow.start(ctx, {
      studentIds: [card.submission.studentId],
      subjectId,
      lessonId,
      assignmentId: card.assignment.id,
      back: sectionCb('assignments', 'sub', submissionId),
    });
  }
}
