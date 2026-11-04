import { Injectable } from '@nestjs/common';
import type { Actor } from '@modules/access/actor.js';
import type { CreatedBot } from '../core/bot-factory.js';
import type { BotContext } from '../core/context.js';
import type { SectionModule } from '../core/sections.js';
import { ProgressScreen, type ProgressSubject } from '../person/progress.screen.js';
import type { StudentSection } from './sections.js';

const ME: ProgressSubject = { side: 'student', child: null };

/** StudentBot → 📊 Успеваемость (4.4, UC-36): journals by teacher, «Сообщить отметку» (UC-30), reports. */
@Injectable()
export class StudentProgressSection implements SectionModule<StudentSection> {
  readonly section = 'progress' as const;

  constructor(private readonly screen: ProgressScreen) {}

  register({ flows }: CreatedBot): void {
    flows.register(this.screen.flow);
  }

  async open(ctx: BotContext, actor: Actor): Promise<void> {
    await this.screen.root(ctx, actor, this.section, ME);
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    const id = args[0] ?? '';
    switch (action) {
      case 'j': // also the «Открыть журнал» button of grade.added / grade.digest
        return this.screen.journal(ctx, actor, this.section, ME, id);
      case 'propose':
        return this.screen.startPropose(ctx, actor, this.section, ME, id);
      case 'reports':
        return this.screen.reports(ctx, actor, this.section, ME);
      case 'r': // also the «Открыть отчёт» button of report.sent
        return this.screen.report(ctx, actor, this.section, ME, id);
      default:
        return this.open(ctx, actor);
    }
  }
}
