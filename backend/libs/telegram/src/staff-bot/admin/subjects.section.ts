import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import { isUuid } from '@shared/ids/index.js';
import type { Actor } from '@modules/access/actor.js';
import { CatalogAdminUseCase } from '@modules/people/catalog-admin.use-case.js';
import { SubjectRepository } from '@modules/people/subject.repository.js';
import type { CreatedBot } from '../../core/bot-factory.js';
import type { BotContext } from '../../core/context.js';
import { Flow, flowCb, type FlowStep } from '../../core/flow.js';
import { escapeHtml, paginate, renderMenu, say } from '../../core/ui.js';
import { sectionCb, type StaffSectionModule } from '../section-module.js';

export interface AddSubjectData extends Record<string, unknown> {
  name: string;
}

const MAX_NAME = 60;

@Injectable()
export class AddSubjectFlow extends Flow<AddSubjectData> {
  readonly name = 'add-subject';
  readonly firstStep = 'name';

  constructor(private readonly catalog: CatalogAdminUseCase) {
    super();
  }

  async initial(): Promise<AddSubjectData> {
    return { name: '' };
  }

  readonly steps: Record<string, FlowStep<AddSubjectData>> = {
    name: {
      enter: async (ctx) =>
        renderMenu(
          ctx,
          ctx.t('subject-add-prompt'),
          new InlineKeyboard().text(ctx.t('btn-cancel'), flowCb('name', 'cancel')),
        ),
      onCallback: async (ctx, _d, action) => {
        if (action === 'cancel') {
          ctx.session.flow = undefined;
          await say(ctx, ctx.t('cancel-done'));
        }
        return { stay: true };
      },
      onText: async (ctx, d, text) => {
        const name = text.trim().replace(/\s+/g, ' ');
        if (!name || name.length > MAX_NAME) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_NAME }));
          return { stay: true };
        }
        d.name = name;
        return { done: true };
      },
    },
  };

  async complete(ctx: BotContext, d: AddSubjectData): Promise<void> {
    if (!ctx.actor) return;
    const back = new InlineKeyboard().text(ctx.t('btn-back'), 'm:open:subjects');
    try {
      const row = await this.catalog.addSubject(ctx.actor.actor, d.name);
      await renderMenu(ctx, ctx.t('subject-added', { name: escapeHtml(row.name) }), back);
    } catch (error) {
      if (!AppError.is(error, 'CONFLICT')) throw error;
      await renderMenu(ctx, ctx.t('subject-exists', { name: escapeHtml(d.name) }), back);
    }
  }
}

/** Admin → Предметы (UC-44, Р-31): list with activity toggles (page kept), add new. */
@Injectable()
export class SubjectsSection implements StaffSectionModule {
  readonly section = 'subjects' as const;

  constructor(
    private readonly subjects: SubjectRepository,
    private readonly catalog: CatalogAdminUseCase,
    private readonly addFlow: AddSubjectFlow,
  ) {}

  register({ flows }: CreatedBot): void {
    flows.register(this.addFlow);
  }

  async open(ctx: BotContext, _actor: Actor, page = 1): Promise<void> {
    const all = await this.subjects.listAll();
    const p = paginate(all, page, 10);
    const kb = new InlineKeyboard();
    for (const s of p.items) {
      kb.text(
        `${s.isActive ? '🟢' : '⚪️'} ${s.name}`,
        sectionCb('subjects', 'toggle', s.id, s.isActive ? 0 : 1, p.page),
      ).row();
    }
    if (p.pages > 1) {
      if (p.page > 1) kb.text('◀️', sectionCb('subjects', 'page', p.page - 1));
      kb.text(`${p.page}/${p.pages}`, sectionCb('subjects', 'noop'));
      if (p.page < p.pages) kb.text('▶️', sectionCb('subjects', 'page', p.page + 1));
      kb.row();
    }
    kb.text(ctx.t('btn-add-subject'), sectionCb('subjects', 'add')).row();
    kb.text(ctx.t('btn-back'), 'm:admin');
    await renderMenu(ctx, ctx.t('subjects-list', { total: all.length }), kb);
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    const page = Math.max(1, Math.trunc(Number(args[2] ?? args[0])) || 1);
    if (action === 'add') return this.addFlow.start(ctx);
    if (action === 'page') return this.open(ctx, actor, page);
    if (action === 'toggle' && isUuid(args[0])) {
      await this.catalog.updateSubject(actor, args[0], { isActive: args[1] === '1' });
      return this.open(ctx, actor, page);
    }
    return this.open(ctx, actor);
  }
}
