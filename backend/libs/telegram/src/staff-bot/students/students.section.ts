import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { Clock } from '@shared/time/clock.js';
import type { Actor } from '@modules/access/actor.js';
import { InviteStudentUseCase } from '@modules/people/links/invite-student.use-case.js';
import {
  cardDisplayName,
  type StudentCard,
  TeacherStudentsQuery,
} from '@modules/people/links/students.query.js';
import type { CreatedBot } from '../../core/bot-factory.js';
import type { BotContext } from '../../core/context.js';
import { clip } from '../../core/format.js';
import { SubjectRepository } from '@modules/people/subject.repository.js';
import { paginate, renderMenu } from '../../core/ui.js';
import { pageLabel } from '../admin/format.js';
import { sectionCb, type StaffSectionModule } from '../section-module.js';
import { pendingState, sendInvitationCard, studentCardText } from './format.js';
import { CardEditScreen } from './card-edit.screen.js';
import { EndLinkFlow } from './end-link.flow.js';
import { InviteStudentFlow } from './invite-student.flow.js';
import { StudentCcScreen } from './cc.screen.js';
import { ParentsScreen } from './parents.screen.js';
import { CreateLessonFlow } from '../schedule/create-lesson.flow.js';

const PAGE_SIZE = 8;
/**
 * StaffBot → Ученики (4.4, 5.4): active students, cards awaiting acceptance, archive, "Добавить ученика"
 * (UC-10), the parents screen (UC-11). Editing the card comes with M2-04, ending the link with M2-06.
 */
@Injectable()
export class StudentsSection implements StaffSectionModule {
  readonly section = 'students' as const;

  constructor(
    private readonly students: TeacherStudentsQuery,
    private readonly invite: InviteStudentUseCase,
    private readonly inviteFlow: InviteStudentFlow,
    private readonly parents: ParentsScreen,
    private readonly cc: StudentCcScreen,
    private readonly subjects: SubjectRepository,
    private readonly editor: CardEditScreen,
    private readonly endFlow: EndLinkFlow,
    private readonly lessonFlow: CreateLessonFlow,
    private readonly clock: Clock,
  ) {}

  register({ flows }: CreatedBot): void {
    flows.register(this.inviteFlow).register(this.editor.flow).register(this.endFlow);
  }

  async open(ctx: BotContext, actor: Actor, page = 1): Promise<void> {
    const [items, counts] = await Promise.all([
      this.students.listActive(actor.accountId),
      this.students.counts(actor.accountId),
    ]);
    const slice = paginate(items, page, PAGE_SIZE);
    const kb = new InlineKeyboard();
    for (const item of slice.items) {
      kb.text(clip(cardDisplayName(item)), sectionCb('students', 'card', item.link.id)).row();
    }
    if (slice.pages > 1) {
      if (slice.page > 1) kb.text('◀️', sectionCb('students', 'page', slice.page - 1));
      kb.text(pageLabel(slice.page, slice.pages), sectionCb('students', 'noop'));
      if (slice.page < slice.pages) kb.text('▶️', sectionCb('students', 'page', slice.page + 1));
      kb.row();
    }
    kb.text(ctx.t('btn-add-student'), sectionCb('students', 'invite')).row();
    if (counts.pending > 0) {
      kb.text(ctx.t('btn-pending-students', { count: counts.pending }), sectionCb('students', 'pending'));
    }
    if (counts.ended > 0) {
      kb.text(ctx.t('btn-archive-students', { count: counts.ended }), sectionCb('students', 'archive'));
    }
    if (counts.pending > 0 || counts.ended > 0) kb.row();
    kb.text(ctx.t('btn-back'), 'm:main');
    const key = counts.active > 0 ? 'students-list' : 'students-empty';
    await renderMenu(ctx, ctx.t(key, { total: counts.active }), kb);
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    const id = args[0];
    switch (action) {
      case 'page':
        return this.open(ctx, actor, Math.max(1, Math.trunc(Number(id)) || 1));
      case 'invite':
        await this.invite.assertCanInvite(actor); // UC-10 3а: a full roster is reported before the dialog
        return this.inviteFlow.start(ctx);
      case 'pending':
        return this.pending(ctx, actor, Math.max(1, Math.trunc(Number(id)) || 1));
      case 'archive':
        return this.archive(ctx, actor, Math.max(1, Math.trunc(Number(id)) || 1));
      case 'card':
        return id ? this.card(ctx, actor, id) : this.open(ctx, actor);
      case 'revoke':
        if (!id) return this.open(ctx, actor);
        await this.invite.revokePending(actor, id);
        await ctx.answerCallbackQuery({ text: ctx.t('student-invite-revoked-ok') }).catch(() => undefined);
        return this.pending(ctx, actor);
      case 'reissue':
        return id ? this.reissue(ctx, actor, id) : this.open(ctx, actor);
      case 'parents':
        return this.withCard(ctx, actor, id, (card) => this.parents.render(ctx, actor, card));
      case 'cc': // NTF-01: copies to parents for this student (M4-05)
      case 'cct':
      case 'ccr':
        return id ? this.cc.handle(ctx, actor, action, id, args[1]) : this.open(ctx, actor);
      case 'pinvite':
        return this.withCard(ctx, actor, id, (card) => this.parents.inviteParent(ctx, actor, card));
      case 'prevoke':
        return this.withCard(ctx, actor, this.parents.cardLinkId(ctx) ?? undefined, async (card) => {
          if (!id || !(await this.parents.confirmRevoke(ctx, card, id)))
            await this.parents.render(ctx, actor, card);
        });
      case 'prevokeok':
        if (id) await this.parents.revokeFamilyLink(ctx, actor, id);
        return this.backToParents(ctx, actor);
      case 'pinvrevoke':
        if (id) await this.parents.revokeInvitation(ctx, actor, id);
        return this.backToParents(ctx, actor);
      case 'edit': // s:students:edit:<field>:<linkId>
        return this.withCard(ctx, actor, args[1], async (card) => {
          if (!(await this.editor.startEdit(ctx, card, id))) await this.card(ctx, actor, card.link.id);
        });
      case 'subjects':
        return this.withCard(ctx, actor, id, (card) => this.editor.subjectsScreen(ctx, card));
      case 'subj': // s:students:subj:<linkId>:<index>:<idPrefix>
        return this.withCard(ctx, actor, id, async (card) => {
          await this.editor.toggleSubject(ctx, actor, card, args);
          await this.withCard(ctx, actor, card.link.id, (fresh) => this.editor.subjectsScreen(ctx, fresh));
        });
      case 'cal':
        return this.withCard(ctx, actor, id, async (card) => {
          await this.editor.toggleCalendar(actor, card);
          await this.card(ctx, actor, card.link.id);
        });
      case 'end': // UC-33
        return this.withCard(ctx, actor, id, (card) => this.endFlow.start(ctx, { linkId: card.link.id }));
      case 'lesson': // UC-14 from the card or the "student joined" notification: the student is preset
        return this.withCard(ctx, actor, id, async (card) => {
          if (card.link.status !== 'active' || !card.link.studentId)
            return this.card(ctx, actor, card.link.id);
          await this.lessonFlow.start(ctx, {
            target: { studentId: card.link.studentId },
            label: cardDisplayName(card),
          });
        });
      default:
        return this.open(ctx, actor);
    }
  }

  async card(ctx: BotContext, actor: Actor, linkId: string): Promise<void> {
    await this.withCard(ctx, actor, linkId, (card) =>
      renderMenu(ctx, studentCardText(ctx, card, this.clock.now()), this.cardKeyboard(ctx, card)),
    );
  }

  /** After a revocation: the parents screen of the card it was opened from, or the list when the session forgot. */
  private async backToParents(ctx: BotContext, actor: Actor): Promise<void> {
    const cardId = this.parents.cardLinkId(ctx);
    if (!cardId) return this.open(ctx, actor);
    await this.withCard(ctx, actor, cardId, (card) => this.parents.render(ctx, actor, card));
  }

  /** Runs `fn` on the teacher's own card; a foreign or unknown id falls back to the list (8.0). */
  private async withCard(
    ctx: BotContext,
    actor: Actor,
    linkId: string | undefined,
    fn: (card: StudentCard) => Promise<void>,
  ): Promise<void> {
    const card = linkId ? await this.students.card(actor.accountId, linkId) : null;
    if (!card) return this.open(ctx, actor);
    await fn(card);
  }

  private cardKeyboard(ctx: BotContext, card: StudentCard): InlineKeyboard {
    const kb = new InlineKeyboard();
    const id = card.link.id;
    if (card.link.status === 'active') return this.editor.keyboard(ctx, card);
    if (card.link.status === 'ended') {
      kb.text(ctx.t('btn-back'), sectionCb('students', 'archive'));
    } else {
      kb.text(ctx.t('btn-reissue-invite'), sectionCb('students', 'reissue', id))
        .text(ctx.t('btn-revoke-invite'), sectionCb('students', 'revoke', id))
        .row();
      kb.text(ctx.t('btn-back'), sectionCb('students', 'pending'));
    }
    return kb;
  }

  private pager(kb: InlineKeyboard, action: string, page: number, pages: number): void {
    if (pages <= 1) return;
    if (page > 1) kb.text('◀️', sectionCb('students', action, page - 1));
    kb.text(pageLabel(page, pages), sectionCb('students', 'noop'));
    if (page < pages) kb.text('▶️', sectionCb('students', action, page + 1));
    kb.row();
  }

  private async pending(ctx: BotContext, actor: Actor, page = 1): Promise<void> {
    const slice = paginate(await this.students.listPending(actor.accountId), page, PAGE_SIZE);
    const now = this.clock.now();
    const kb = new InlineKeyboard();
    for (const item of slice.items) {
      const name = clip(cardDisplayName({ link: item.link, student: null }), 24);
      kb.text(`${name} · ${pendingState(ctx, item, now)}`, sectionCb('students', 'card', item.link.id)).row();
    }
    this.pager(kb, 'pending', slice.page, slice.pages);
    kb.text(ctx.t('btn-back'), sectionCb('students', 'list'));
    await renderMenu(ctx, ctx.t(slice.items.length > 0 ? 'students-pending' : 'students-pending-empty'), kb);
  }

  private async archive(ctx: BotContext, actor: Actor, page = 1): Promise<void> {
    const slice = paginate(await this.students.listEnded(actor.accountId), page, PAGE_SIZE);
    const kb = new InlineKeyboard();
    for (const item of slice.items) {
      kb.text(clip(cardDisplayName(item)), sectionCb('students', 'card', item.link.id)).row();
    }
    this.pager(kb, 'archive', slice.page, slice.pages);
    kb.text(ctx.t('btn-back'), sectionCb('students', 'list'));
    await renderMenu(ctx, ctx.t(slice.items.length > 0 ? 'students-archive' : 'students-archive-empty'), kb);
  }

  /** A fresh link for an expired or declined card as a new forwardable message (INV-05: tokens are never stored). */
  private async reissue(ctx: BotContext, actor: Actor, linkId: string): Promise<void> {
    const { link, issued } = await this.invite.reissue(actor, linkId);
    await sendInvitationCard(ctx, link, issued, await this.subjects.findByIds(link.subjectIds));
  }
}
