import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { isUuid } from '@shared/ids/index.js';
import { formatInZone } from '@shared/time/timezone.js';
import type { Actor } from '@modules/access/actor.js';
import { FileDeliveryService } from '@modules/files/file-delivery.service.js';
import { AssignmentsUseCase } from '@modules/homework/assignments.use-case.js';
import { ReviewUseCase } from '@modules/homework/review.use-case.js';
import { type AssignmentCard, HomeworkQuery, type SubmissionCard } from '@modules/homework/homework.query.js';
import { LessonsQuery } from '@modules/schedule/lessons/lessons.query.js';
import type { CreatedBot } from '../../core/bot-factory.js';
import type { BotContext } from '../../core/context.js';
import { clip, fullName } from '../../core/format.js';
import { escapeHtml, paginate, renderMenu, say } from '../../core/ui.js';
import { pageLabel } from '../admin/format.js';
import { sectionCb, type StaffSectionModule } from '../section-module.js';
import { CreateAssignmentFlow } from './create-assignment.flow.js';
import { ReviewFlow } from './review.flow.js';

const PAGE_SIZE = 8;
const WHEN = 'dd.MM HH:mm';

/**
 * StaffBot → Задания (UC-26, UC-28, 5.10): the list with counters, the queue «На проверке (N)», the
 * assignment card with every addressee's status, the submission card (files as an album) and the review.
 */
@Injectable()
export class AssignmentsSection implements StaffSectionModule {
  readonly section = 'assignments' as const;

  constructor(
    private readonly query: HomeworkQuery,
    private readonly assignments: AssignmentsUseCase,
    private readonly review: ReviewUseCase,
    private readonly lessons: LessonsQuery,
    private readonly delivery: FileDeliveryService,
    private readonly createFlow: CreateAssignmentFlow,
    private readonly reviewFlow: ReviewFlow,
  ) {}

  register({ flows }: CreatedBot): void {
    flows.register(this.createFlow).register(this.reviewFlow);
  }

  async open(ctx: BotContext, actor: Actor, page = 1): Promise<void> {
    const [items, queue] = await Promise.all([
      this.query.teacherList(actor.accountId, ['draft', 'published']),
      this.query.queueCount(actor.accountId),
    ]);
    const closed = await this.query.teacherList(actor.accountId, ['closed']);
    const slice = paginate(items, page, PAGE_SIZE);
    const kb = new InlineKeyboard();
    for (const it of slice.items) {
      const mark = it.assignment.status === 'draft' ? '✏️' : it.counts.submitted > 0 ? '📥' : '📝';
      const label = `${mark} ${clip(it.assignment.title, 26)} · ${it.counts.accepted}/${it.counts.accepted + it.counts.submitted + it.counts.assigned + it.counts.overdue + it.counts.returned}`;
      kb.text(label, sectionCb('assignments', 'a', it.assignment.id)).row();
    }
    if (slice.pages > 1) {
      if (slice.page > 1) kb.text('◀️', sectionCb('assignments', 'page', slice.page - 1));
      kb.text(pageLabel(slice.page, slice.pages), sectionCb('assignments', 'noop'));
      if (slice.page < slice.pages) kb.text('▶️', sectionCb('assignments', 'page', slice.page + 1));
      kb.row();
    }
    kb.text(ctx.t('btn-new-assignment'), sectionCb('assignments', 'new'));
    kb.text(ctx.t('btn-review-queue', { count: queue }), sectionCb('assignments', 'queue')).row();
    if (closed.length > 0)
      kb.text(
        ctx.t('btn-closed-assignments', { count: closed.length }),
        sectionCb('assignments', 'closed'),
      ).row();
    kb.text(ctx.t('btn-back'), 'm:main');
    await renderMenu(
      ctx,
      ctx.t(items.length > 0 ? 'assignments-list' : 'assignments-empty', { active: items.length }),
      kb,
    );
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    const id = args[0];
    switch (action) {
      case 'list':
        return this.open(ctx, actor);
      case 'page':
        return this.open(ctx, actor, Math.max(1, Math.trunc(Number(id)) || 1));
      case 'new': // s:assignments:new[:<lessonId>] — from the list or from the lesson report (UC-24 → UC-26)
        return this.startCreate(ctx, actor, isUuid(id) ? id : null);
      case 'a':
        return isUuid(id) ? this.card(ctx, actor, id) : this.open(ctx, actor);
      case 'publish':
        if (isUuid(id)) {
          await this.assignments.publish(actor, id);
          await say(ctx, ctx.t('assignment-published'));
          return this.card(ctx, actor, id);
        }
        return this.open(ctx, actor);
      case 'close':
        if (isUuid(id)) {
          await this.assignments.close(actor, id);
          await say(ctx, ctx.t('assignment-closed'));
          return this.card(ctx, actor, id);
        }
        return this.open(ctx, actor);
      case 'closed':
        return this.closedList(ctx, actor);
      case 'queue':
        return this.queue(ctx, actor);
      case 'sub': // also the «Открыть» button of `submission.received`
        return isUuid(id) ? this.submission(ctx, actor, id) : this.queue(ctx, actor);
      case 'files':
        return isUuid(id) ? this.sendFiles(ctx, actor, id) : this.queue(ctx, actor);
      case 'accept':
        return isUuid(id)
          ? this.reviewFlow.start(ctx, { submissionId: id, decision: 'accepted' })
          : this.queue(ctx, actor);
      case 'return':
        return isUuid(id)
          ? this.reviewFlow.start(ctx, { submissionId: id, decision: 'returned' })
          : this.queue(ctx, actor);
      case 'purge': // Р-27: free the storage of a reviewed submission
        if (!isUuid(id)) return this.queue(ctx, actor);
        await say(ctx, ctx.t('submission-files-purged', { count: await this.review.purgeFiles(actor, id) }));
        return this.submission(ctx, actor, id);
      default:
        return this.open(ctx, actor);
    }
  }

  /** From a lesson: participants and the lesson are preset (5.6.4 «выдача из итогов занятия»). */
  private async startCreate(ctx: BotContext, actor: Actor, lessonId: string | null): Promise<void> {
    if (!lessonId) return this.createFlow.start(ctx);
    const view = await this.lessons.teacherLesson(actor.accountId, lessonId);
    await this.createFlow.start(ctx, {
      lessonId: view.lesson.id,
      studentIds: view.participants.map((p) => p.student.id),
      groupIds: [],
    });
  }

  async card(ctx: BotContext, actor: Actor, assignmentId: string): Promise<void> {
    const card = await this.query.card(actor.accountId, assignmentId);
    const a = card.assignment;
    const zone = ctx.actor?.account.timezone ?? 'UTC';
    const kb = new InlineKeyboard();
    if (a.status === 'draft')
      kb.text(ctx.t('btn-publish-assignment'), sectionCb('assignments', 'publish', a.id)).row();
    if (a.status === 'published')
      kb.text(ctx.t('btn-close-assignment'), sectionCb('assignments', 'close', a.id)).row();
    for (const t of card.targets.filter((t) => t.submission && t.target.status === 'submitted').slice(0, 10))
      kb.text(
        `📥 ${clip(t.student ? fullName(t.student) : '—', 30)}`,
        sectionCb('assignments', 'sub', t.submission!.id),
      ).row();
    kb.text(ctx.t('btn-back'), sectionCb('assignments', 'list'));
    await renderMenu(ctx, this.cardText(ctx, card, zone), kb);
  }

  private cardText(ctx: BotContext, card: AssignmentCard, zone: string): string {
    const a = card.assignment;
    const targets = card.targets
      .map((t) =>
        ctx.t('target-line', {
          status: t.target.status,
          name: escapeHtml(t.student ? fullName(t.student) : '—'),
          due:
            t.target.dueAt && a.dueMode === 'next_lesson'
              ? ` · ${formatInZone(t.target.dueAt, zone, WHEN)}`
              : '',
        }),
      )
      .join('\n');
    return ctx.t('assignment-card', {
      title: escapeHtml(a.title),
      body: a.body ? `\n${escapeHtml(a.body)}` : '',
      due: ctx.t('assignment-due', {
        mode: a.dueMode,
        due: a.dueAt ? formatInZone(a.dueAt, zone, WHEN) : '',
      }),
      mode: ctx.t('submission-mode', { mode: a.submissionMode }),
      status: ctx.t('assignment-status', { status: a.status }),
      targets,
    });
  }

  private async closedList(ctx: BotContext, actor: Actor): Promise<void> {
    const items = await this.query.teacherList(actor.accountId, ['closed']);
    const kb = new InlineKeyboard();
    for (const it of items.slice(0, 20))
      kb.text(`🔒 ${clip(it.assignment.title, 32)}`, sectionCb('assignments', 'a', it.assignment.id)).row();
    kb.text(ctx.t('btn-back'), sectionCb('assignments', 'list'));
    await renderMenu(ctx, ctx.t('btn-closed-assignments', { count: items.length }), kb);
  }

  /** 5.10.4 «На проверке (N)»: oldest first. */
  private async queue(ctx: BotContext, actor: Actor): Promise<void> {
    const cards = await this.query.queue(actor.accountId);
    const zone = ctx.actor?.account.timezone ?? 'UTC';
    const kb = new InlineKeyboard();
    for (const c of cards.slice(0, 20)) {
      const who = c.student ? fullName(c.student) : '—';
      kb.text(
        `${formatInZone(c.submission.submittedAt, zone, 'dd.MM')} ${clip(who, 18)} · ${clip(c.assignment.title, 14)}`,
        sectionCb('assignments', 'sub', c.submission.id),
      ).row();
    }
    kb.text(ctx.t('btn-back'), sectionCb('assignments', 'list'));
    await renderMenu(ctx, ctx.t(cards.length > 0 ? 'queue-list' : 'queue-empty'), kb);
  }

  /** UC-28 steps 2–3: the card, then the files as an album. */
  private async submission(ctx: BotContext, actor: Actor, submissionId: string): Promise<void> {
    const c = await this.query.submissionCard(actor.accountId, submissionId);
    const zone = ctx.actor?.account.timezone ?? 'UTC';
    const kb = new InlineKeyboard();
    if (!c.review) {
      kb.text(ctx.t('btn-accept'), sectionCb('assignments', 'accept', c.submission.id))
        .text(ctx.t('btn-return'), sectionCb('assignments', 'return', c.submission.id))
        .row()
        .text(ctx.t('btn-grade'), sectionCb('journals', 'grade', c.submission.id));
    }
    const live = c.files.filter((f) => f.status !== 'deleted');
    if (live.length > 0)
      kb.text(
        ctx.t('btn-send-files', { count: live.length }),
        sectionCb('assignments', 'files', c.submission.id),
      );
    if (c.review && live.length + c.reviewFiles.filter((f) => f.status !== 'deleted').length > 0)
      kb.text(ctx.t('btn-purge-files'), sectionCb('assignments', 'purge', c.submission.id));
    kb.row().text(ctx.t('btn-back'), sectionCb('assignments', 'a', c.assignment.id));
    await renderMenu(ctx, this.submissionText(ctx, c, zone), kb);
    if (c.files.some((f) => f.status !== 'deleted')) await this.sendFiles(ctx, actor, c.submission.id, c);
  }

  private submissionText(ctx: BotContext, c: SubmissionCard, zone: string): string {
    const review = c.review
      ? '\n\n' +
        ctx.t('submission-review-line', {
          decision: c.review.decision,
          when: formatInZone(c.review.reviewedAt, zone, WHEN),
          comment: c.review.comment ? `: ${escapeHtml(c.review.comment)}` : '',
        })
      : '';
    return ctx.t('submission-card', {
      student: escapeHtml(c.student ? fullName(c.student) : '—'),
      title: escapeHtml(c.assignment.title),
      when: formatInZone(c.submission.submittedAt, zone, WHEN),
      late: c.submission.isLate ? 'yes' : 'no',
      attempt: c.submission.attemptNo,
      text: c.submission.text
        ? `\n\n${ctx.t('submission-text', { text: escapeHtml(c.submission.text) })}`
        : '',
      review,
    });
  }

  private async sendFiles(
    ctx: BotContext,
    actor: Actor,
    submissionId: string,
    card?: SubmissionCard,
  ): Promise<void> {
    const c = card ?? (await this.query.submissionCard(actor.accountId, submissionId));
    if (!ctx.chat || c.files.length === 0) return;
    const report = await this.delivery.sendMany(ctx.api, 'staff', ctx.chat.id, c.files);
    if (report.skipped.some((f) => f.scanStatus === 'infected')) await say(ctx, ctx.t('file-infected-note'));
    else if (report.skipped.length > 0) await say(ctx, ctx.t('smat-file-pending'));
  }
}
