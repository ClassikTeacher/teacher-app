import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import type { Actor } from '@modules/access/actor.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { linkView } from '@modules/people/links/link.rules.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { SubjectRepository } from '@modules/people/subject.repository.js';
import type { CreatedBot } from '../core/bot-factory.js';
import type { BotContext } from '../core/context.js';
import { clip, fullName } from '../core/format.js';
import { type SectionModule, sectionCb } from '../core/sections.js';
import { escapeHtml, renderMenu } from '../core/ui.js';
import { backToMain } from '../person/person-menu.js';
import { LeaveFlow } from './leave.flow.js';
import type { StudentSection } from './sections.js';

/**
 * StudentBot → Мои учителя (4.4): active links with subjects; the card offers "Написать учителю".
 * "Попросить о переносе" arrives with M4, "Прекратить занятия" with M2-06.
 */
@Injectable()
export class StudentTeachersSection implements SectionModule<StudentSection> {
  readonly section = 'teachers' as const;

  constructor(
    private readonly links: TeacherStudentRepository,
    private readonly accounts: AccountRepository,
    private readonly subjects: SubjectRepository,
    private readonly leaveFlow: LeaveFlow,
  ) {}

  register({ flows }: CreatedBot): void {
    flows.register(this.leaveFlow);
  }

  async open(ctx: BotContext, actor: Actor): Promise<void> {
    const links = await this.links.listByStudent(actor.accountId, ['active']);
    const teachers = new Map(
      (await this.accounts.findByIds(links.map((l) => l.teacherId))).map((a) => [a.id, a]),
    );
    const kb = new InlineKeyboard();
    let shown = 0;
    for (const link of links) {
      const teacher = teachers.get(link.teacherId);
      // ACC-04: a blocked teacher's students see the link as ended (it moves to the archive)
      if (!teacher || linkView(link, teacher.status, actor.status) !== 'full') continue;
      kb.text(clip(fullName(teacher)), sectionCb('teachers', 'card', link.id)).row();
      shown += 1;
    }
    kb.text(ctx.t('btn-back'), 'm:main');
    await renderMenu(ctx, ctx.t(shown > 0 ? 'student-teachers-list' : 'student-teachers-empty'), kb);
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    if (action === 'card' && args[0]) return this.card(ctx, actor, args[0]);
    if (action === 'leave' && args[0]) return this.leave(ctx, actor, args[0]);
    return this.open(ctx, actor);
  }

  private async card(ctx: BotContext, actor: Actor, linkId: string): Promise<void> {
    const link = await this.links.findById(linkId);
    if (!link || link.studentId !== actor.accountId) return this.open(ctx, actor); // 8.0: only own links
    const teacher = await this.accounts.findById(link.teacherId);
    if (!teacher || linkView(link, teacher.status, actor.status) !== 'full') return this.open(ctx, actor);
    const subjects = await this.subjects.findByIds(link.subjectIds);
    const kb = new InlineKeyboard();
    if (teacher.username) kb.url(ctx.t('btn-write-teacher'), `https://t.me/${teacher.username}`).row();
    kb.text(ctx.t('btn-leave-teacher'), sectionCb('teachers', 'leave', link.id)).row();
    kb.text(ctx.t('btn-back'), sectionCb('teachers', 'list'));
    await renderMenu(
      ctx,
      ctx.t('student-teacher-card', {
        teacher: escapeHtml(fullName(teacher)),
        subjects: escapeHtml(subjects.map((s) => s.name).join(', ') || '—'),
        limit: link.maxLessonsPerWeek === null ? ctx.t('limit-none') : String(link.maxLessonsPerWeek),
      }),
      kb,
    );
  }

  /** UC-34: only the student's own active link (8.0). */
  private async leave(ctx: BotContext, actor: Actor, linkId: string): Promise<void> {
    const link = await this.links.findById(linkId);
    if (!link || link.studentId !== actor.accountId || link.status !== 'active') return this.open(ctx, actor);
    const teacher = await this.accounts.findById(link.teacherId);
    await this.leaveFlow.start(ctx, { linkId: link.id, teacherName: teacher ? fullName(teacher) : '—' });
  }

  backKeyboard(ctx: BotContext): InlineKeyboard {
    return backToMain(ctx);
  }
}
