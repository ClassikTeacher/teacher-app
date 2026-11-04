import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import { isUuid } from '@shared/ids/index.js';
import type { Actor } from '@modules/access/actor.js';
import { ContentAccessQuery } from '@modules/content/content-access.query.js';
import type { MaterialRow } from '@modules/content/schema.js';
import { FileDeliveryService } from '@modules/files/file-delivery.service.js';
import { FileRepository } from '@modules/files/file.repository.js';
import type { BotContext } from '../core/context.js';
import { clip, fullName } from '../core/format.js';
import { type SectionModule, sectionCb } from '../core/sections.js';
import { escapeHtml, renderMenu, say } from '../core/ui.js';
import type { StudentSection } from './sections.js';

const MAX_ITEMS = 20;
const KIND_ICON = { file: '📄', link: '🔗', text: '📝' } as const;

/**
 * StudentBot → Материалы (5.9.4): teacher → collections and single materials → the material itself (file,
 * link button, text). Access is checked at every step (MAT-01); opening marks «просмотрено».
 */
@Injectable()
export class StudentMaterialsSection implements SectionModule<StudentSection> {
  readonly section = 'materials' as const;

  constructor(
    private readonly access: ContentAccessQuery,
    private readonly files: FileRepository,
    private readonly delivery: FileDeliveryService,
  ) {}

  async open(ctx: BotContext, actor: Actor): Promise<void> {
    const teachers = await this.access.teachersFor(actor.accountId);
    if (teachers.length === 1) return this.library(ctx, actor, teachers[0]!.id);
    const kb = new InlineKeyboard();
    for (const t of teachers) kb.text(clip(fullName(t)), sectionCb('materials', 't', t.id)).row();
    kb.text(ctx.t('btn-back'), 'm:main');
    await renderMenu(ctx, ctx.t(teachers.length > 0 ? 'smat-teachers' : 'smat-empty'), kb);
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    const id = args[0];
    switch (action) {
      case 't':
        return isUuid(id) ? this.library(ctx, actor, id) : this.open(ctx, actor);
      case 'c':
        return isUuid(id) ? this.collection(ctx, actor, id) : this.open(ctx, actor);
      case 'm': // also the «Открыть» button of `material.granted`
        return isUuid(id) ? this.material(ctx, actor, id) : this.open(ctx, actor);
      case 'file':
        return isUuid(id) ? this.sendFile(ctx, actor, id) : this.open(ctx, actor);
      default:
        return this.open(ctx, actor);
    }
  }

  private async library(ctx: BotContext, actor: Actor, teacherId: string): Promise<void> {
    const lib = await this.access.libraryFor(actor.accountId, teacherId);
    const kb = new InlineKeyboard();
    for (const c of lib.collections.slice(0, MAX_ITEMS))
      kb.text(
        `📚 ${clip(c.collection.title, 30)} (${c.materials.length})`,
        sectionCb('materials', 'c', c.collection.id),
      ).row();
    for (const m of lib.materials.slice(0, MAX_ITEMS))
      kb.text(this.label(m, lib.viewed), sectionCb('materials', 'm', m.id)).row();
    kb.text(ctx.t('btn-back'), sectionCb('materials', 'list'));
    const empty = lib.collections.length === 0 && lib.materials.length === 0;
    await renderMenu(
      ctx,
      ctx.t(empty ? 'smat-library-empty' : 'smat-library', { teacher: escapeHtml(fullName(lib.teacher)) }),
      kb,
    );
  }

  private async collection(ctx: BotContext, actor: Actor, collectionId: string): Promise<void> {
    const found = await this.access.collectionFor(actor.accountId, collectionId);
    if (!found) {
      const back = new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('materials', 'list'));
      await renderMenu(ctx, ctx.t('smat-no-access'), back);
      return;
    }
    const viewed = await this.access.viewedBy(
      actor.accountId,
      found.materials.map((m) => m.id),
    );
    const kb = new InlineKeyboard();
    for (const m of found.materials.slice(0, MAX_ITEMS))
      kb.text(this.label(m, viewed), sectionCb('materials', 'm', m.id)).row();
    kb.text(ctx.t('btn-back'), sectionCb('materials', 't', found.collection.teacherId));
    const c = found.collection;
    const period = c.periodFrom ? ` · ${c.periodFrom}${c.periodTo ? ` — ${c.periodTo}` : ''}` : '';
    await renderMenu(
      ctx,
      ctx.t('smat-collection', { title: escapeHtml(c.title), period, count: found.materials.length }),
      kb,
    );
  }

  private async material(ctx: BotContext, actor: Actor, materialId: string): Promise<void> {
    const m = await this.access.materialFor(actor.accountId, materialId);
    if (!m) {
      await renderMenu(
        ctx,
        ctx.t('smat-no-access'),
        new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('materials', 'list')),
      );
      return;
    }
    await this.access.markViewed(actor.accountId, m.id);
    const kb = new InlineKeyboard();
    if (m.kind === 'link' && m.url) kb.url(ctx.t('btn-open-link'), m.url).row();
    kb.text(ctx.t('btn-back'), sectionCb('materials', 't', m.teacherId));
    const body = m.kind === 'text' ? `\n\n${escapeHtml(m.body ?? '')}` : '';
    const description = m.description ? `\n${escapeHtml(m.description)}` : '';
    await renderMenu(
      ctx,
      ctx.t('smat-material', { icon: KIND_ICON[m.kind], title: escapeHtml(m.title), description, body }),
      kb,
    );
    if (m.kind === 'file') await this.sendFile(ctx, actor, m.id);
  }

  /** The file itself, from the cache of StudentBot or from S3 (7.5). */
  private async sendFile(ctx: BotContext, actor: Actor, materialId: string): Promise<void> {
    const m = await this.access.materialFor(actor.accountId, materialId);
    if (!m?.fileId || !ctx.chat) return;
    const file = await this.files.findById(m.fileId);
    if (!file) return;
    try {
      await this.delivery.send(ctx.api, 'student', ctx.chat.id, file, escapeHtml(m.title));
    } catch (error) {
      if (AppError.is(error, 'CONFLICT')) return say(ctx, ctx.t('smat-file-pending'));
      throw error;
    }
  }

  private label(m: MaterialRow, viewed: ReadonlySet<string>): string {
    return `${KIND_ICON[m.kind]} ${clip(m.title, 28)}${viewed.has(m.id) ? ' ✓' : ''}`;
  }
}
