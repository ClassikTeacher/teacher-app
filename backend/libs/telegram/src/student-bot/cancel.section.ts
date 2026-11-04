import { Injectable } from '@nestjs/common';
import type { Actor } from '@modules/access/actor.js';
import type { CreatedBot } from '../core/bot-factory.js';
import type { BotContext } from '../core/context.js';
import { type SectionModule } from '../core/sections.js';
import { PersonBulkCancelFlow } from '../person/bulk-cancel.flow.js';
import type { StudentSection } from './sections.js';

/** StudentBot → ❌ Отменить занятие (4.4): the bulk dialog of UC-23; single lessons are cancelled from their card. */
@Injectable()
export class StudentCancelSection implements SectionModule<StudentSection> {
  readonly section = 'cancel' as const;

  constructor(private readonly bulk: PersonBulkCancelFlow) {}

  register({ flows }: CreatedBot): void {
    flows.register(this.bulk);
  }

  async open(ctx: BotContext, actor: Actor): Promise<void> {
    await this.bulk.start(ctx, { studentId: actor.accountId, backCb: 'm:main' });
  }

  async onCallback(ctx: BotContext, actor: Actor): Promise<void> {
    await this.open(ctx, actor);
  }
}
