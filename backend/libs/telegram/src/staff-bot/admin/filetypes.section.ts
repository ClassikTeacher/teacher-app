import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import type { Actor } from '@modules/access/actor.js';
import { CatalogAdminUseCase } from '@modules/people/catalog-admin.use-case.js';
import { FileTypeRepository } from '@modules/people/file-type.repository.js';
import type { BotContext } from '../../core/context.js';
import { paginate, renderMenu } from '../../core/ui.js';
import { sectionCb, type StaffSectionModule } from '../section-module.js';

const PAGE_SIZE = 15;
const EXT = /^[a-z0-9]{1,10}$/;

/** Admin → Типы файлов (UC-44, 5.10.3): one toggle per extension, paginated; new extensions are added via REST. */
@Injectable()
export class FileTypesSection implements StaffSectionModule {
  readonly section = 'filetypes' as const;

  constructor(
    private readonly fileTypes: FileTypeRepository,
    private readonly catalog: CatalogAdminUseCase,
  ) {}

  async open(ctx: BotContext, _actor: Actor, page = 1): Promise<void> {
    const p = paginate(await this.fileTypes.listAll(), page, PAGE_SIZE);
    const kb = new InlineKeyboard();
    p.items.forEach((t, i) => {
      kb.text(
        `${t.isAllowed ? '🟢' : '⚪️'} .${t.ext}`,
        sectionCb('filetypes', 'toggle', t.ext, t.isAllowed ? 0 : 1, p.page),
      );
      if (i % 3 === 2) kb.row();
    });
    if (p.items.length % 3 !== 0) kb.row();
    if (p.pages > 1) {
      if (p.page > 1) kb.text('◀️', sectionCb('filetypes', 'page', p.page - 1));
      kb.text(`${p.page}/${p.pages}`, sectionCb('filetypes', 'noop'));
      if (p.page < p.pages) kb.text('▶️', sectionCb('filetypes', 'page', p.page + 1));
      kb.row();
    }
    kb.text(ctx.t('btn-back'), 'm:admin');
    await renderMenu(ctx, ctx.t('filetypes-list'), kb);
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    if (action === 'page') return this.open(ctx, actor, Math.max(1, Math.trunc(Number(args[0])) || 1));
    if (action === 'toggle' && args[0] && EXT.test(args[0])) {
      await this.catalog.setFileTypeAllowed(actor, args[0], args[1] === '1');
      return this.open(ctx, actor, Math.max(1, Math.trunc(Number(args[2])) || 1));
    }
    return this.open(ctx, actor);
  }
}
