import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { formatInZone } from '@shared/time/timezone.js';
import type { Actor } from '@modules/access/actor.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { linkView } from '@modules/people/links/link.rules.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { SubjectRepository } from '@modules/people/subject.repository.js';
import type { BotContext } from '../core/context.js';
import { clip, fullName } from '../core/format.js';
import { type SectionModule, sectionCb } from '../core/sections.js';
import { escapeHtml, renderMenu } from '../core/ui.js';
import { backToMain } from '../person/person-menu.js';
import type { StudentSection } from './sections.js';

/**
 * StudentBot → Архив (5.8.4, Р-6, 8.0): read-only history with teachers whose link ended or who are blocked
 * (ACC-04). A blocked student never reaches this screen (ACC-01: the gate refuses them).
 */
@Injectable()
export class StudentArchiveSection implements SectionModule<StudentSection> {
  readonly section = 'archive' as const;

  constructor(
    private readonly links: TeacherStudentRepository,
    private readonly accounts: AccountRepository,
    private readonly subjects: SubjectRepository,
  ) {}

  private async archived(actor: Actor) {
    const links = await this.links.listByStudent(actor.accountId, ['active', 'ended']);
    const teachers = new Map(
      (await this.accounts.findByIds(links.map((l) => l.teacherId))).map((a) => [a.id, a]),
    );
    return links.flatMap((link) => {
      const teacher = teachers.get(link.teacherId);
      return teacher && linkView(link, teacher.status, actor.status) === 'archive' ? [{ link, teacher }] : [];
    });
  }

  async open(ctx: BotContext, actor: Actor): Promise<void> {
    const items = await this.archived(actor);
    const kb = new InlineKeyboard();
    for (const { link, teacher } of items)
      kb.text(clip(fullName(teacher)), sectionCb('archive', 'card', link.id)).row();
    kb.text(ctx.t('btn-back'), 'm:main');
    await renderMenu(ctx, ctx.t(items.length > 0 ? 'student-archive-list' : 'student-archive-empty'), kb);
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    if (action === 'card' && args[0]) return this.card(ctx, actor, args[0]);
    return this.open(ctx, actor);
  }

  private async card(ctx: BotContext, actor: Actor, linkId: string): Promise<void> {
    const item = (await this.archived(actor)).find((i) => i.link.id === linkId);
    if (!item) return this.open(ctx, actor);
    const { link, teacher } = item;
    const periods = await this.links.listPeriods(link.id);
    const tz = ctx.actor?.account.timezone ?? 'UTC';
    const subjects = await this.subjects.findByIds(link.subjectIds);
    const history = periods
      .map(
        (p) =>
          `${formatInZone(p.startedAt, tz, 'dd.MM.yyyy')} — ${p.endedAt ? formatInZone(p.endedAt, tz, 'dd.MM.yyyy') : '…'}`,
      )
      .join(', ');
    const state =
      link.status === 'ended'
        ? ctx.t(`end-reason-${(link.endReason ?? 'system').replace(/_/g, '-')}`)
        : ctx.t('student-archive-teacher-blocked');
    await renderMenu(
      ctx,
      ctx.t('student-archive-card', {
        teacher: escapeHtml(fullName(teacher)),
        subjects: escapeHtml(subjects.map((s) => s.name).join(', ') || '—'),
        state,
        history: escapeHtml(history || '—'),
      }),
      new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('archive', 'list')),
    );
  }

  backKeyboard(ctx: BotContext): InlineKeyboard {
    return backToMain(ctx);
  }
}
