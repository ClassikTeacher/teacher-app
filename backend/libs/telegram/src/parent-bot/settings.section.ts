import { Injectable } from '@nestjs/common';
import type { Actor } from '@modules/access/actor.js';
import type { CreatedBot } from '../core/bot-factory.js';
import type { BotContext } from '../core/context.js';
import { type SectionModule, sectionCb } from '../core/sections.js';
import { IcsScreen } from '../person/ics.screen.js';
import { NotificationEditFlow } from '../person/notification-edit.flow.js';
import { NotificationSettingsScreen } from '../person/notification-settings.screen.js';
import type { ParentSection } from './sections.js';

/** ParentBot → ⚙️ Настройки (4.4): quiet hours and non-critical copies (NTF-02, NTF-06). */
@Injectable()
export class ParentSettingsSection implements SectionModule<ParentSection> {
  readonly section = 'settings' as const;

  constructor(
    private readonly screen: NotificationSettingsScreen,
    private readonly ics: IcsScreen,
    private readonly edit: NotificationEditFlow,
  ) {}

  register({ flows }: CreatedBot): void {
    flows.register(this.edit);
  }

  async open(ctx: BotContext, actor: Actor): Promise<void> {
    await this.screen.render(ctx, actor, this.section, 'm:main');
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    const main = sectionCb(this.section, 'nmain');
    if (await this.ics.handle(ctx, actor, this.section, action, main)) return;
    if (!(await this.screen.handle(ctx, actor, this.section, action, args, 'm:main')))
      await this.open(ctx, actor);
  }
}
