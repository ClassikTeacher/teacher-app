import { Injectable } from '@nestjs/common';
import type { Actor } from '@modules/access/actor.js';
import type { CreatedBot } from '../../core/bot-factory.js';
import type { BotContext } from '../../core/context.js';
import type { StaffSectionModule } from '../section-module.js';
import { CreateLessonFlow } from './create-lesson.flow.js';

/** StaffBot → ➕ Занятие (4.4): the quick-create dialog of UC-14. */
@Injectable()
export class LessonSection implements StaffSectionModule {
  readonly section = 'lesson' as const;

  constructor(private readonly createFlow: CreateLessonFlow) {}

  register({ flows }: CreatedBot): void {
    flows.register(this.createFlow);
  }

  async open(ctx: BotContext, _actor: Actor): Promise<void> {
    await this.createFlow.start(ctx);
  }

  async onCallback(ctx: BotContext, actor: Actor): Promise<void> {
    await this.open(ctx, actor);
  }
}
