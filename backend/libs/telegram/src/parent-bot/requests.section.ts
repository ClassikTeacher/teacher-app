import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import type { Actor } from '@modules/access/actor.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { LeaveRequestRepository } from '@modules/people/links/leave-request.repository.js';
import { LeaveRequestUseCase } from '@modules/people/links/leave-request.use-case.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import type { LeaveRequestRow } from '@modules/people/schema.js';
import type { BotContext } from '../core/context.js';
import { fullName } from '../core/format.js';
import { type SectionModule, sectionCb } from '../core/sections.js';
import { escapeHtml, renderMenu, say } from '../core/ui.js';
import type { ParentSection } from './sections.js';

/**
 * ParentBot → Запросы (UC-35): pending leave requests of the parent's children with Approve / Decline.
 * The same decisions arrive as buttons on the notification (`m:lr:ok|no:<requestId>`), handled by ParentBot.
 */
@Injectable()
export class RequestsSection implements SectionModule<ParentSection> {
  readonly section = 'requests' as const;

  constructor(
    private readonly family: FamilyLinkRepository,
    private readonly links: TeacherStudentRepository,
    private readonly requests: LeaveRequestRepository,
    private readonly leaves: LeaveRequestUseCase,
    private readonly accounts: AccountRepository,
  ) {}

  private async pendingOf(
    parentId: string,
  ): Promise<Array<{ request: LeaveRequestRow; student: string; teacher: string }>> {
    const children = await this.family.listActiveByParent(parentId);
    const links = (
      await Promise.all(children.map((c) => this.links.listByStudent(c.studentId, ['active'])))
    ).flat();
    const pending = await this.requests.listPendingByLinks(links.map((l) => l.id));
    const byLink = new Map(links.map((l) => [l.id, l]));
    const ids = [...new Set(links.flatMap((l) => [l.teacherId, l.studentId!]))];
    const names = new Map((await this.accounts.findByIds(ids)).map((a) => [a.id, fullName(a)]));
    return pending.map((request) => {
      const link = byLink.get(request.teacherStudentId)!;
      return {
        request,
        student: names.get(link.studentId!) ?? '—',
        teacher: names.get(link.teacherId) ?? '—',
      };
    });
  }

  async open(ctx: BotContext, actor: Actor): Promise<void> {
    const items = await this.pendingOf(actor.accountId);
    const kb = new InlineKeyboard();
    const lines = items.map(({ request, student, teacher }, i) => {
      kb.text(`${i + 1} ✅`, sectionCb('requests', 'ok', request.id))
        .text(`${i + 1} ❌`, sectionCb('requests', 'no', request.id))
        .row();
      return ctx.t('parent-request-line', {
        n: i + 1,
        student: escapeHtml(student),
        teacher: escapeHtml(teacher),
        reason: escapeHtml(request.reason),
      });
    });
    kb.text(ctx.t('btn-back'), 'm:main');
    const body = lines.length > 0 ? lines.join('\n\n') : ctx.t('parent-requests-empty');
    await renderMenu(ctx, `${ctx.t('parent-requests-title')}\n\n${body}`, kb);
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    if ((action === 'ok' || action === 'no') && args[0])
      await this.decide(ctx, actor, args[0], action === 'ok');
    return this.open(ctx, actor);
  }

  /** LINK-03: the first answer wins; a late second answer is reported as already decided. */
  async decide(ctx: BotContext, actor: Actor, requestId: string, approve: boolean): Promise<void> {
    try {
      await this.leaves.decide(actor, requestId, approve, null);
      await say(ctx, ctx.t(approve ? 'parent-request-approved' : 'parent-request-declined'));
    } catch (error) {
      if (AppError.is(error, 'CONFLICT')) return say(ctx, ctx.t('parent-request-already-decided'));
      // a request of someone else's child (crafted or stale button): nothing to reveal
      if (AppError.is(error, 'FORBIDDEN') || AppError.is(error, 'NOT_FOUND'))
        return say(ctx, ctx.t('callback-stale'));
      throw error;
    }
  }
}
