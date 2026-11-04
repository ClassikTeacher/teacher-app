import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import type { Actor } from '@modules/access/actor.js';
import { cardDisplayName, type StudentCard } from '@modules/people/links/students.query.js';
import { UpdateStudentCardUseCase } from '@modules/people/links/update-student-card.use-case.js';
import { SubjectRepository } from '@modules/people/subject.repository.js';
import type { BotContext } from '../../core/context.js';
import { escapeHtml, renderMenu } from '../../core/ui.js';
import { subjectByRef, subjectPickerKeyboard, subjectRef } from '../common/subject-picker.js';
import { sectionCb } from '../section-module.js';
import { CardEditFlow, isCardEditField } from './card-edit.flow.js';

/** Calendar override cycles default → open → closed → default (5.4.1 "открытость календаря для этого ученика"). */
export function nextCalendarState(current: boolean | null): boolean | null {
  if (current === null) return true;
  return current ? false : null;
}

export function calendarStateKey(value: boolean | null): 'default' | 'open' | 'closed' {
  return value === null ? 'default' : value ? 'open' : 'closed';
}

/**
 * Editing part of the student card (M2-04): the keyboard of an active card, one-field dialogs, the subjects
 * picker (callback carries the card id and a collision-checked subject reference, so a button left on an old
 * message cannot edit another card) and the calendar override toggle.
 */
@Injectable()
export class CardEditScreen {
  constructor(
    private readonly updateCard: UpdateStudentCardUseCase,
    private readonly subjects: SubjectRepository,
    private readonly editFlow: CardEditFlow,
  ) {}

  get flow(): CardEditFlow {
    return this.editFlow;
  }

  /** Buttons of an active card. */
  keyboard(ctx: BotContext, card: StudentCard): InlineKeyboard {
    const id = card.link.id;
    return new InlineKeyboard()
      .text(ctx.t('btn-parents'), sectionCb('students', 'parents', id))
      .text(ctx.t('btn-cc-student'), sectionCb('students', 'cc', id))
      .text(ctx.t('btn-create-lesson'), sectionCb('students', 'lesson', id))
      .row()
      .text(ctx.t('btn-edit-alias'), sectionCb('students', 'edit', 'alias', id))
      .text(ctx.t('btn-edit-grade'), sectionCb('students', 'edit', 'grade', id))
      .text(ctx.t('btn-edit-school'), sectionCb('students', 'edit', 'school', id))
      .row()
      .text(ctx.t('btn-edit-subjects'), sectionCb('students', 'subjects', id))
      .text(ctx.t('btn-edit-limit'), sectionCb('students', 'edit', 'limit', id))
      .row()
      .text(ctx.t('btn-edit-goals'), sectionCb('students', 'edit', 'goals', id))
      .text(ctx.t('btn-edit-notes'), sectionCb('students', 'edit', 'notes', id))
      .row()
      .text(
        ctx.t(`btn-calendar-${calendarStateKey(card.link.calendarOpen)}`),
        sectionCb('students', 'cal', id),
      )
      .text(ctx.t('btn-end-link'), sectionCb('students', 'end', id))
      .row()
      .text(ctx.t('btn-back'), sectionCb('students', 'list'));
  }

  /** `s:students:edit:<field>:<linkId>` */
  async startEdit(ctx: BotContext, card: StudentCard, field: string | undefined): Promise<boolean> {
    if (!field || !isCardEditField(field)) return false;
    await this.editFlow.start(ctx, { linkId: card.link.id, field });
    return true;
  }

  /** Subjects of the card: toggling adds journals for new subjects (JRN-02); the last one cannot be removed. */
  async subjectsScreen(ctx: BotContext, card: StudentCard): Promise<void> {
    const active = await this.subjects.listActive();
    const kb = subjectPickerKeyboard(
      ctx,
      active,
      card.link.subjectIds,
      (_subject, index) => sectionCb('students', 'subj', card.link.id, ...subjectRef(active, index)),
      sectionCb('students', 'card', card.link.id),
    );
    await renderMenu(ctx, ctx.t('card-subjects-screen', { student: escapeHtml(cardDisplayName(card)) }), kb);
  }

  /** `s:students:subj:<linkId>:<index>:<idSuffix>` — a stale reference (catalogue changed) is refused. */
  async toggleSubject(ctx: BotContext, actor: Actor, card: StudentCard, args: string[]): Promise<void> {
    const subject = subjectByRef(await this.subjects.listActive(), args[1], args[2]);
    if (!subject) {
      await ctx.answerCallbackQuery({ text: ctx.t('callback-stale') }).catch(() => undefined);
      return;
    }
    if (card.link.subjectIds.includes(subject.id) && card.link.subjectIds.length === 1) {
      await ctx.answerCallbackQuery({ text: ctx.t('onb-subjects-required') }).catch(() => undefined);
      return;
    }
    await this.updateCard.toggleSubject(actor, card.link.id, subject.id);
  }

  async toggleCalendar(actor: Actor, card: StudentCard): Promise<void> {
    await this.updateCard.execute(actor, card.link.id, {
      calendarOpen: nextCalendarState(card.link.calendarOpen),
    });
  }
}
