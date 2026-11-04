import { Injectable } from '@nestjs/common';
import type { Actor } from '@modules/access/actor.js';
import type { CreatedBot } from '../core/bot-factory.js';
import type { BotContext } from '../core/context.js';
import { type SectionModule } from '../core/sections.js';
import { BookSlotFlow } from '../person/book-slot.flow.js';
import type { StudentSection } from './sections.js';

/** StudentBot → ➕ Записаться (4.4): UC-16 for teachers whose calendar is open for the student (5.5.5). */
@Injectable()
export class StudentBookingSection implements SectionModule<StudentSection> {
  readonly section = 'booking' as const;

  constructor(private readonly flow: BookSlotFlow) {}

  register({ flows }: CreatedBot): void {
    flows.register(this.flow);
  }

  async open(ctx: BotContext, _actor: Actor): Promise<void> {
    await this.flow.start(ctx, { backCb: 'm:main' });
  }

  async onCallback(ctx: BotContext, actor: Actor): Promise<void> {
    await this.open(ctx, actor);
  }
}
