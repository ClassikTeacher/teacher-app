import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { isUuid } from '@shared/ids/index.js';
import { formatInZone } from '@shared/time/timezone.js';
import type { Actor } from '@modules/access/actor.js';
import { FileDeliveryService } from '@modules/files/file-delivery.service.js';
import {
  type AttemptView,
  HomeworkQuery,
  type StudentAssignmentItem,
} from '@modules/homework/homework.query.js';
import { AppError } from '@shared/errors/app-error.js';
import { DEFAULT_MAX_FILES, SUBMITTABLE } from '@modules/homework/homework.rules.js';
import type { TargetStatus } from '@modules/homework/schema.js';
import { SubmitUseCase } from '@modules/homework/submit.use-case.js';
import type { CreatedBot } from '../core/bot-factory.js';
import type { BotContext } from '../core/context.js';
import { clip, fullName } from '../core/format.js';
import { type SectionModule, sectionCb } from '../core/sections.js';
import { escapeHtml, renderMenu, say } from '../core/ui.js';
import { personZone } from '../person/lesson-format.js';
import type { StudentSection } from './sections.js';
import { SubmitFlow } from './submit.flow.js';

const WHEN = 'dd.MM HH:mm';
const MAX_ITEMS = 20;
const ACTIVE: readonly TargetStatus[] = ['assigned', 'overdue', 'returned', 'submitted'];
const FINISHED: readonly TargetStatus[] = ['accepted', 'withdrawn'];
const ORDER = { overdue: 0, returned: 1, assigned: 2, submitted: 3, accepted: 4, withdrawn: 5 } as const;

/**
 * StudentBot → Задания (5.10.3): active work first (overdue and returned on top, then by due date), the card
 * with the condition, the attempts and the teacher's verdict, «Сдать» / «Выполнено».
 */
@Injectable()
export class StudentAssignmentsSection implements SectionModule<StudentSection> {
  readonly section = 'assignments' as const;

  constructor(
    private readonly query: HomeworkQuery,
    private readonly submit: SubmitUseCase,
    private readonly delivery: FileDeliveryService,
    private readonly submitFlow: SubmitFlow,
  ) {}

  register({ flows }: CreatedBot): void {
    flows.register(this.submitFlow);
  }

  async open(ctx: BotContext, actor: Actor, finished = false): Promise<void> {
    const zone = personZone(ctx);
    const statuses: readonly TargetStatus[] = finished ? FINISHED : ACTIVE;
    const items = await this.query.studentList(actor.accountId, statuses);
    items.sort(
      (a, b) =>
        ORDER[a.target.status] - ORDER[b.target.status] ||
        (a.target.dueAt?.getTime() ?? Infinity) - (b.target.dueAt?.getTime() ?? Infinity),
    );
    const shown = items.slice(0, MAX_ITEMS);
    const kb = new InlineKeyboard();
    for (const it of shown)
      kb.text(clip(this.line(ctx, it, zone), 40), sectionCb('assignments', 'a', it.assignment.id)).row();
    if (!finished) kb.text(ctx.t('btn-finished-assignments'), sectionCb('assignments', 'done'));
    kb.text(ctx.t('btn-back'), finished ? sectionCb('assignments', 'list') : 'm:main');
    const lines = shown.map((it) => this.line(ctx, it, zone)).join('\n');
    await renderMenu(
      ctx,
      ctx.t(shown.length > 0 ? 'shw-list' : 'shw-empty', { active: items.length, items: lines }),
      kb,
    );
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    const id = args[0];
    switch (action) {
      case 'list':
        return this.open(ctx, actor);
      case 'done':
        return this.open(ctx, actor, true);
      case 'a': // also the buttons of homework.* and submission.reviewed
        return isUuid(id) ? this.card(ctx, actor, id) : this.open(ctx, actor);
      case 'submit':
        return isUuid(id) ? this.startSubmit(ctx, actor, id) : this.open(ctx, actor);
      case 'mark':
        if (!isUuid(id)) return this.open(ctx, actor);
        try {
          await this.submit.execute(actor, { assignmentId: id, fileIds: [] });
          await say(ctx, ctx.t('shw-marked-done'));
        } catch (error) {
          if (!AppError.is(error, 'CONFLICT') && !AppError.is(error, 'VALIDATION_ERROR')) throw error;
          const raw = error.details?.['reason'];
          const reason = (typeof raw === 'string' ? raw : 'conflict').replace(/_/g, '-');
          await say(ctx, ctx.t(`submit-refused-${reason}`));
        }
        return this.card(ctx, actor, id);
      case 'rfiles': // the teacher's checked files of the latest reviewed attempt
        return isUuid(id) ? this.reviewFiles(ctx, actor, id) : this.open(ctx, actor);
      default:
        return this.open(ctx, actor);
    }
  }

  private line(ctx: BotContext, it: StudentAssignmentItem, zone: string): string {
    return ctx.t('shw-line', {
      status: it.target.status,
      title: escapeHtml(it.assignment.title),
      due: it.target.dueAt ? formatInZone(it.target.dueAt, zone, WHEN) : ctx.t('hw-no-due'),
    });
  }

  private async card(ctx: BotContext, actor: Actor, assignmentId: string): Promise<void> {
    const { assignment, target } = await this.submit.forStudent(actor, assignmentId);
    await this.submit.markViewed(actor, assignmentId);
    const zone = personZone(ctx);
    const history = await this.query.studentHistory(target.id);
    const kb = new InlineKeyboard();
    const canSubmit = SUBMITTABLE.includes(target.status) && assignment.status === 'published';
    if (canSubmit && assignment.submissionMode === 'mark')
      kb.text(ctx.t('btn-mark-done'), sectionCb('assignments', 'mark', assignment.id));
    else if (canSubmit && assignment.submissionMode !== 'none')
      kb.text(ctx.t('btn-submit'), sectionCb('assignments', 'submit', assignment.id));
    const reviewed = history.find((h) => h.review);
    if (reviewed && reviewed.reviewFiles.length > 0)
      kb.text(
        ctx.t('btn-review-files', { count: reviewed.reviewFiles.length }),
        sectionCb('assignments', 'rfiles', assignment.id),
      );
    kb.row().text(ctx.t('btn-back'), sectionCb('assignments', 'list'));
    const item = await this.query.studentItem(actor.accountId, assignment.id);
    await renderMenu(
      ctx,
      ctx.t('shw-card', {
        title: escapeHtml(assignment.title),
        teacher: escapeHtml(item?.teacher ? fullName(item.teacher) : '—'),
        body: assignment.body ? `\n${escapeHtml(assignment.body)}` : '',
        due: target.dueAt ? formatInZone(target.dueAt, zone, WHEN) : ctx.t('hw-no-due'),
        status: ctx.t('shw-status', { status: target.status }),
        history: history.map((h) => this.attempt(ctx, h, zone)).join(''),
      }),
      kb,
    );
  }

  private attempt(ctx: BotContext, h: AttemptView, zone: string): string {
    const review = h.review
      ? ctx.t('shw-review', {
          decision: h.review.decision,
          comment: h.review.comment ? `: ${escapeHtml(h.review.comment)}` : '',
        })
      : '';
    return `\n${ctx.t('shw-attempt', {
      attempt: h.submission.attemptNo,
      when: formatInZone(h.submission.submittedAt, zone, WHEN),
      review,
    })}`;
  }

  private async startSubmit(ctx: BotContext, actor: Actor, assignmentId: string): Promise<void> {
    const { assignment } = await this.submit.forStudent(actor, assignmentId);
    await this.submitFlow.start(ctx, {
      assignmentId: assignment.id,
      teacherId: assignment.teacherId,
      title: assignment.title,
      mode: assignment.submissionMode,
      allowedExts: assignment.submissionRules.allowedExts ?? null,
      maxFiles: assignment.submissionRules.maxFiles ?? DEFAULT_MAX_FILES,
    });
  }

  private async reviewFiles(ctx: BotContext, actor: Actor, assignmentId: string): Promise<void> {
    const { target } = await this.submit.forStudent(actor, assignmentId);
    const reviewed = (await this.query.studentHistory(target.id)).find((h) => h.review);
    if (!reviewed || !ctx.chat) return;
    await this.delivery.sendMany(ctx.api, 'student', ctx.chat.id, reviewed.reviewFiles);
  }
}
