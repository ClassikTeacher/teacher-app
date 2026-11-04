import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { EndLinkUseCase } from '@modules/people/links/end-link.use-case.js';
import { MAX_END_MESSAGE_LENGTH } from '@modules/people/links/link.rules.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { TeacherStudentsQuery, cardDisplayName } from '@modules/people/links/students.query.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { TeacherSettingsUseCase } from '@modules/people/teacher-settings.use-case.js';
import type { BotContext } from '../../core/context.js';
import { clip } from '../../core/format.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../../core/flow.js';
import { escapeHtml, renderMenu, say } from '../../core/ui.js';
import { isTerminalFlowError } from '../common/flow-errors.js';
import { resolveRef, shortRef } from '../common/short-ref.js';
import { sectionCb } from '../section-module.js';

export interface EndLinkData extends Record<string, unknown> {
  linkId: string;
  studentName: string;
  message: string;
}

/**
 * UC-33: card → message (a template, the default notice text or free text) → consequences screen → confirm.
 * The link ends with `removed_by_teacher`; the student and parents receive the message (5.8.1).
 */
@Injectable()
export class EndLinkFlow extends Flow<EndLinkData> {
  readonly name = 'end-link';
  readonly firstStep = 'message';

  constructor(
    private readonly endLink: EndLinkUseCase,
    private readonly links: TeacherStudentRepository,
    private readonly students: TeacherStudentsQuery,
    private readonly profiles: TeacherProfileRepository,
    private readonly settings: TeacherSettingsUseCase,
  ) {
    super();
  }

  async initial(ctx: BotContext, arg: unknown): Promise<EndLinkData> {
    const { linkId } = arg as { linkId: string };
    const card = ctx.actor ? await this.students.card(ctx.actor.account.id, linkId) : null;
    return { linkId, studentName: card ? cardDisplayName(card) : '—', message: '' };
  }

  private async templates(ctx: BotContext): Promise<string[]> {
    if (!ctx.actor) return [];
    const [profile, rows] = await Promise.all([
      this.profiles.find(ctx.actor.account.id),
      this.settings.listTemplates(ctx.actor.actor, 'end_link'),
    ]);
    return [...rows.map((r) => r.text), ...(profile?.defaultNoticeText ? [profile.defaultNoticeText] : [])];
  }

  private async leave(ctx: BotContext, d: EndLinkData, key: string): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(
      ctx,
      ctx.t(key),
      new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('students', 'card', d.linkId)),
    );
    return { stay: true };
  }

  readonly steps: Record<string, FlowStep<EndLinkData>> = {
    message: {
      enter: async (ctx, d) => {
        const options = await this.templates(ctx);
        const kb = new InlineKeyboard();
        options.forEach((text, i) =>
          kb.text(clip(text, 40), flowCb('message', 'pick', ...shortRef(text, i))).row(),
        );
        kb.text(ctx.t('btn-cancel'), flowCb('message', 'cancel'));
        await renderMenu(ctx, ctx.t('end-link-message', { student: escapeHtml(d.studentName) }), kb);
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.leave(ctx, d, 'cancel-done');
        if (action !== 'pick') return { stay: true };
        const picked = resolveRef(await this.templates(ctx), args[0], args[1], (t) => t);
        if (!picked) return { stay: true };
        d.message = picked;
        return { goto: 'confirm' };
      },
      onText: async (ctx, d, text) => {
        if (!text || text.length > MAX_END_MESSAGE_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_END_MESSAGE_LENGTH }));
          return { stay: true };
        }
        d.message = text;
        return { goto: 'confirm' };
      },
    },
    confirm: {
      enter: async (ctx, d) => {
        const link = await this.links.findById(d.linkId);
        const c = link
          ? await this.endLink.consequences(link)
          : { groups: 0, lessons: null, assignments: null, activeParents: 0 };
        const kb = new InlineKeyboard()
          .text(ctx.t('btn-confirm-end-link'), flowCb('confirm', 'ok'))
          .text(ctx.t('btn-cancel'), flowCb('confirm', 'cancel'));
        await renderMenu(
          ctx,
          ctx.t('end-link-confirm', {
            student: escapeHtml(d.studentName),
            message: escapeHtml(d.message),
            groups: c.groups,
            parents: c.activeParents,
            lessons: c.lessons === null ? ctx.t('end-link-lessons-later') : String(c.lessons),
          }),
          kb,
        );
      },
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.leave(ctx, d, 'cancel-done');
        return action === 'ok' ? { done: true } : { stay: true };
      },
    },
  };

  async complete(ctx: BotContext, d: EndLinkData): Promise<void> {
    if (!ctx.actor) return;
    try {
      await this.endLink.execute(ctx.actor.actor, d.linkId, {
        reason: 'removed_by_teacher',
        message: d.message,
      });
    } catch (error) {
      if (isTerminalFlowError(error)) ctx.session.flow = undefined;
      throw error;
    }
    const kb = new InlineKeyboard().text(ctx.t('btn-to-students'), sectionCb('students', 'list'));
    await renderMenu(ctx, ctx.t('end-link-done', { student: escapeHtml(d.studentName) }), kb);
  }
}
