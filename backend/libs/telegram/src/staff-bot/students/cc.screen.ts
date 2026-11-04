import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import type { Actor } from '@modules/access/actor.js';
import { NotificationSettingsUseCase } from '@modules/notifications/notification-settings.use-case.js';
import { CC_CONFIGURABLE_TYPES } from '@modules/notifications/types.js';
import { cardDisplayName, TeacherStudentsQuery } from '@modules/people/links/students.query.js';
import type { BotContext } from '../../core/context.js';
import { escapeHtml, renderMenu } from '../../core/ui.js';
import { sectionCb } from '../section-module.js';

/** The student card → «Копии родителям» (NTF-01): per-type override of the teacher's defaults, with a reset. */
@Injectable()
export class StudentCcScreen {
  constructor(
    private readonly settings: NotificationSettingsUseCase,
    private readonly students: TeacherStudentsQuery,
  ) {}

  private typeName(ctx: BotContext, code: string): string {
    return ctx.t('notif-type-name', { code: code.replace(/[._]/g, '-') });
  }

  /** `s:students:cc:<linkId>` renders; `cct:<linkId>:<idx>` toggles; `ccr:<linkId>` resets. */
  async handle(ctx: BotContext, actor: Actor, action: string, linkId: string, arg?: string): Promise<void> {
    let card;
    try {
      card = await this.students.card(actor.accountId, linkId);
    } catch (error) {
      if (!AppError.is(error, 'NOT_FOUND')) throw error;
      return;
    }
    const studentId = card?.link.studentId;
    if (!card || !studentId) return;
    if (action === 'cct') {
      const type = CC_CONFIGURABLE_TYPES[Number(arg)];
      if (type) await this.settings.toggleStudentCc(actor, studentId, type);
    } else if (action === 'ccr') await this.settings.resetStudentCc(actor, studentId);
    const view = await this.settings.studentCc(actor, studentId);
    const kb = new InlineKeyboard();
    view.items.forEach((item, i) => {
      const mark = item.enabled ? '☑️' : '⬜';
      const star = item.overridden ? ' *' : '';
      kb.text(
        `${mark} ${this.typeName(ctx, item.type)}${star}`,
        sectionCb('students', 'cct', linkId, i),
      ).row();
    });
    kb.text(ctx.t('btn-notif-reset'), sectionCb('students', 'ccr', linkId)).text(
      ctx.t('btn-back'),
      sectionCb('students', 'card', linkId),
    );
    const defaults = view.items
      .filter((i) => !i.overridden && i.enabled)
      .map((i) => this.typeName(ctx, i.type))
      .join(', ');
    await renderMenu(
      ctx,
      ctx.t('notif-cc-student', {
        student: escapeHtml(cardDisplayName(card)),
        default: defaults || ctx.t('notif-none'),
      }),
      kb,
    );
  }
}
