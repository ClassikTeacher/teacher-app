import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import type { Actor } from '@modules/access/actor.js';
import { LessonsQuery } from '@modules/schedule/lessons/lessons.query.js';
import type { CreatedBot } from '../../core/bot-factory.js';
import type { BotContext } from '../../core/context.js';
import { renderMenu } from '../../core/ui.js';
import { sectionCb, type StaffSectionModule } from '../section-module.js';
import { zoneOf } from './day-picker.js';
import { lessonButtonLabel, lessonLine } from './lesson-format.js';
import { LessonReportFlow } from './lesson-report.flow.js';
import { fmtDayOf } from './time-input.js';

/** StaffBot → ⚠️ Требует внимания (LES-07): lessons waiting for their report; each opens the report dialog. */
@Injectable()
export class AttentionSection implements StaffSectionModule {
  readonly section = 'attention' as const;

  constructor(
    private readonly lessons: LessonsQuery,
    private readonly reportFlow: LessonReportFlow,
  ) {}

  register({ flows }: CreatedBot): void {
    flows.register(this.reportFlow);
  }

  async open(ctx: BotContext, actor: Actor): Promise<void> {
    const zone = zoneOf(ctx);
    const items = await this.lessons.awaitingReport(actor.accountId);
    const kb = new InlineKeyboard();
    for (const view of items) {
      kb.text(
        `${fmtDayOf(view.lesson.startsAt, zone)} ${lessonButtonLabel(ctx, view, zone)}`,
        sectionCb('today', 'rep', view.lesson.id, 'topic'),
      ).row();
    }
    kb.text(ctx.t('btn-back'), 'm:main');
    const lines = items
      .map((v) => `${fmtDayOf(v.lesson.startsAt, zone)} ${lessonLine(ctx, v, zone)}`)
      .join('\n');
    await renderMenu(
      ctx,
      items.length > 0 ? `${ctx.t('attention-list')}\n${lines}` : ctx.t('attention-empty'),
      kb,
    );
  }

  async onCallback(ctx: BotContext, actor: Actor): Promise<void> {
    await this.open(ctx, actor);
  }
}
