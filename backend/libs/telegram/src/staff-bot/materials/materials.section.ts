import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { isUuid } from '@shared/ids/index.js';
import { formatInZone } from '@shared/time/timezone.js';
import type { Actor } from '@modules/access/actor.js';
import { GrantsUseCase } from '@modules/content/grants.use-case.js';
import { type GrantView, MaterialsQuery } from '@modules/content/materials.query.js';
import { MaterialsUseCase } from '@modules/content/materials.use-case.js';
import type { Release } from '@modules/content/schema.js';
import { FileDeliveryService } from '@modules/files/file-delivery.service.js';
import { LessonsQuery } from '@modules/schedule/lessons/lessons.query.js';
import type { CreatedBot } from '../../core/bot-factory.js';
import type { BotContext } from '../../core/context.js';
import { clip, fullName } from '../../core/format.js';
import { mediaOf, UPLOADABLE_KINDS } from '../../core/media.js';
import { escapeHtml, paginate, renderMenu, say } from '../../core/ui.js';
import { pageLabel } from '../admin/format.js';
import { resolveRef, shortRef } from '../common/short-ref.js';
import { sectionCb, type StaffSectionModule } from '../section-module.js';
import { AddMaterialFlow } from './add-material.flow.js';
import { CreateCollectionFlow } from './create-collection.flow.js';
import { GrantFlow } from './grant.flow.js';
import { UploadMaterialFlow } from './upload-material.flow.js';

const PAGE_SIZE = 8;
const KIND_ICON = { file: '📄', link: '🔗', text: '📝' } as const;
const PICK_KEY = 'materialsPick';
const GRANTS_KEY = 'materialsGrants';

/**
 * StaffBot → Материалы (UC-25, 5.9): the library, a material card with grants and views, collections,
 * lesson attachments. A file sent to the bot outside any dialog starts the upload (5.9.1).
 */
@Injectable()
export class MaterialsSection implements StaffSectionModule {
  readonly section = 'materials' as const;

  constructor(
    private readonly query: MaterialsQuery,
    private readonly materials: MaterialsUseCase,
    private readonly grants: GrantsUseCase,
    private readonly lessons: LessonsQuery,
    private readonly delivery: FileDeliveryService,
    private readonly uploadFlow: UploadMaterialFlow,
    private readonly addFlow: AddMaterialFlow,
    private readonly grantFlow: GrantFlow,
    private readonly collectionFlow: CreateCollectionFlow,
  ) {}

  register({ bot, flows }: CreatedBot): void {
    flows
      .register(this.uploadFlow)
      .register(this.addFlow)
      .register(this.grantFlow)
      .register(this.collectionFlow);
    // a teacher drops a file into the chat → «загрузка материала» (5.9.1); an active dialog keeps its files
    bot.on(['message:document', 'message:photo', 'message:audio', 'message:video'], async (ctx, next) => {
      if (ctx.session.flow || !ctx.actor?.actor.roles.includes('TEACHER')) return next();
      const media = mediaOf(ctx.message);
      if (!media || !UPLOADABLE_KINDS.includes(media.kind)) return next();
      if (media.kind === 'photo') await say(ctx, ctx.t('upload-photo-hint'));
      await this.uploadFlow.start(ctx, { file: media.file, mediaGroupId: media.mediaGroupId });
    });
  }

  async open(ctx: BotContext, actor: Actor, page = 1): Promise<void> {
    const [items, collections] = await Promise.all([
      this.query.list(actor.accountId),
      this.query.collections(actor.accountId),
    ]);
    const slice = paginate(items, page, PAGE_SIZE);
    const kb = new InlineKeyboard();
    for (const m of slice.items)
      kb.text(`${KIND_ICON[m.kind]} ${clip(m.title, 32)}`, sectionCb('materials', 'm', m.id)).row();
    if (slice.pages > 1) {
      if (slice.page > 1) kb.text('◀️', sectionCb('materials', 'page', slice.page - 1));
      kb.text(pageLabel(slice.page, slice.pages), sectionCb('materials', 'noop'));
      if (slice.page < slice.pages) kb.text('▶️', sectionCb('materials', 'page', slice.page + 1));
      kb.row();
    }
    kb.text(ctx.t('btn-upload-material'), sectionCb('materials', 'upload'))
      .text(ctx.t('btn-add-link'), sectionCb('materials', 'addlink'))
      .text(ctx.t('btn-add-text'), sectionCb('materials', 'addtext'))
      .row();
    kb.text(ctx.t('btn-collections', { count: collections.length }), sectionCb('materials', 'cols')).row();
    kb.text(ctx.t('btn-back'), 'm:main');
    await renderMenu(
      ctx,
      ctx.t(items.length > 0 ? 'materials-list' : 'materials-empty', { total: items.length }),
      kb,
    );
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    const id = args[0];
    switch (action) {
      case 'list':
        return this.open(ctx, actor);
      case 'page':
        return this.open(ctx, actor, Math.max(1, Math.trunc(Number(id)) || 1));
      case 'upload':
        return this.uploadFlow.start(ctx);
      case 'addlink':
        return this.addFlow.start(ctx, { kind: 'link' });
      case 'addtext':
        return this.addFlow.start(ctx, { kind: 'text' });
      case 'm':
        return isUuid(id) ? this.card(ctx, actor, id) : this.open(ctx, actor);
      case 'file':
        return isUuid(id) ? this.sendFile(ctx, actor, id) : this.open(ctx, actor);
      case 'grant': // s:materials:grant:<m|c>:<id>
        return this.startGrant(ctx, actor, args[0], args[1]);
      case 'grants':
        return isUuid(id) ? this.grantsScreen(ctx, actor, id) : this.open(ctx, actor);
      case 'rv': // s:materials:rv:<idx>:<check> — the grant list lives in the session (two UUIDs do not fit)
        return this.revoke(ctx, actor, args[0], args[1]);
      case 'del': // Р-27: two steps — the confirmation screen, then the deletion
        if (!isUuid(id)) return this.open(ctx, actor);
        return renderMenu(
          ctx,
          ctx.t('material-delete-confirm', {
            title: escapeHtml((await this.query.card(actor.accountId, id)).material.title),
          }),
          new InlineKeyboard()
            .text(ctx.t('btn-delete-confirm'), sectionCb('materials', 'delok', id))
            .text(ctx.t('btn-back'), sectionCb('materials', 'm', id)),
        );
      case 'delok':
        if (isUuid(id)) await this.materials.delete(actor, id);
        await say(ctx, ctx.t('material-deleted'));
        return this.open(ctx, actor);
      case 'arch':
        if (isUuid(id)) await this.materials.archive(actor, id);
        await say(ctx, ctx.t('material-archived'));
        return this.open(ctx, actor);
      case 'tocol': // pick a collection for a material
        return isUuid(id) ? this.pickCollection(ctx, actor, id) : this.open(ctx, actor);
      case 'tocolok': // s:materials:tocolok:<idx>:<check>
        return this.addToCollection(ctx, actor, args[0], args[1]);
      case 'cols':
        return this.collections(ctx, actor);
      case 'newcol':
        return this.collectionFlow.start(ctx);
      case 'col':
        return isUuid(id) ? this.collectionCard(ctx, actor, id) : this.collections(ctx, actor);
      case 'coladd': // pick a material for a collection
        return isUuid(id)
          ? this.pickMaterial(ctx, actor, { collectionId: id })
          : this.collections(ctx, actor);
      case 'lesson':
        return isUuid(id) ? this.lessonMaterials(ctx, actor, id) : this.open(ctx, actor);
      case 'attach': // s:materials:attach:<lessonId>:<before|after>
        return isUuid(id) && (args[1] === 'before' || args[1] === 'after')
          ? this.pickMaterial(ctx, actor, { lessonId: id, release: args[1] })
          : this.open(ctx, actor);
      case 'pick': // s:materials:pick:<idx>:<check>
        return this.picked(ctx, actor, args[0], args[1]);
      default:
        return this.open(ctx, actor);
    }
  }

  async card(ctx: BotContext, actor: Actor, materialId: string): Promise<void> {
    const card = await this.query.card(actor.accountId, materialId);
    const m = card.material;
    const kind =
      m.kind === 'file'
        ? ctx.t('material-kind-file', {
            name: escapeHtml(card.file?.originalName ?? '—'),
            size: `${Math.max(1, Math.round((card.file?.size ?? 0) / 1024))} КБ`,
          })
        : m.kind === 'link'
          ? ctx.t('material-kind-link', { url: escapeHtml(m.url ?? '') })
          : ctx.t('material-kind-text');
    const text = ctx.t('material-card', {
      title: escapeHtml(m.title),
      kind,
      description: m.description ? `\n${escapeHtml(m.description)}` : '',
      grants: card.grants.length,
      views: card.views.length,
      collections:
        card.collections.length > 0
          ? ctx.t('material-in-collections', {
              names: escapeHtml(card.collections.map((c) => c.title).join(', ')),
            })
          : '',
    });
    const kb = new InlineKeyboard()
      .text(ctx.t('btn-grant'), sectionCb('materials', 'grant', 'm', m.id))
      .text(
        ctx.t('btn-material-grants', { count: card.grants.length }),
        sectionCb('materials', 'grants', m.id),
      )
      .row()
      .text(ctx.t('btn-to-collection'), sectionCb('materials', 'tocol', m.id));
    if (m.kind === 'file') kb.text(ctx.t('btn-get-file'), sectionCb('materials', 'file', m.id));
    kb.row()
      .text(ctx.t('btn-archive-material'), sectionCb('materials', 'arch', m.id))
      .text(ctx.t('btn-delete-material'), sectionCb('materials', 'del', m.id))
      .row();
    kb.text(ctx.t('btn-back'), sectionCb('materials', 'list'));
    await renderMenu(ctx, text, kb);
  }

  private async sendFile(ctx: BotContext, actor: Actor, materialId: string): Promise<void> {
    const card = await this.query.card(actor.accountId, materialId);
    if (!card.file || !ctx.chat) return;
    await this.delivery.send(ctx.api, 'staff', ctx.chat.id, card.file, escapeHtml(card.material.title));
  }

  private async startGrant(
    ctx: BotContext,
    actor: Actor,
    kind: string | undefined,
    id: string | undefined,
  ): Promise<void> {
    if (!isUuid(id)) return this.open(ctx, actor);
    if (kind === 'c') {
      const col = await this.query.collectionCard(actor.accountId, id);
      return this.grantFlow.start(ctx, {
        subjectType: 'collection',
        subjectId: id,
        title: col.collection.title,
        backCb: sectionCb('materials', 'col', id),
      });
    }
    const card = await this.query.card(actor.accountId, id);
    await this.grantFlow.start(ctx, {
      subjectType: 'material',
      subjectId: id,
      title: card.material.title,
      backCb: sectionCb('materials', 'm', id),
    });
  }

  private granteeLabel(g: GrantView): string {
    return g.group ? `👥 ${g.group.name}` : g.student ? fullName(g.student) : '—';
  }

  private async grantsScreen(ctx: BotContext, actor: Actor, materialId: string): Promise<void> {
    const card = await this.query.card(actor.accountId, materialId);
    const zone = ctx.actor?.account.timezone ?? 'UTC';
    const shown = card.grants.slice(0, 20);
    ctx.session.scratch = {
      ...ctx.session.scratch,
      [GRANTS_KEY]: { materialId, ids: shown.map((g) => g.grant.id) },
    };
    const kb = new InlineKeyboard();
    shown.forEach((g, i) => {
      const from = g.grant.availableFrom
        ? ctx.t('grant-from', { date: formatInZone(g.grant.availableFrom, zone, 'dd.MM.yyyy') })
        : '';
      const label = ctx.t('grant-line', { who: this.granteeLabel(g), from });
      kb.text(`✖️ ${clip(label, 36)}`, sectionCb('materials', 'rv', ...shortRef(g.grant.id, i))).row();
    });
    kb.text(ctx.t('btn-back'), sectionCb('materials', 'm', materialId));
    const key = card.grants.length > 0 ? 'grants-list' : 'grants-empty';
    await renderMenu(ctx, ctx.t(key, { title: escapeHtml(card.material.title) }), kb);
  }

  private async revoke(ctx: BotContext, actor: Actor, index?: string, check?: string): Promise<void> {
    const pick = ctx.session.scratch?.[GRANTS_KEY] as { materialId: string; ids: string[] } | undefined;
    const grantId = pick ? resolveRef(pick.ids, index, check, (x) => x) : null;
    if (!pick || !grantId) return this.open(ctx, actor);
    await this.grants.revoke(actor, grantId);
    await ctx.answerCallbackQuery({ text: ctx.t('grant-revoked') }).catch(() => undefined);
    await this.grantsScreen(ctx, actor, pick.materialId);
  }

  private async pickCollection(ctx: BotContext, actor: Actor, materialId: string): Promise<void> {
    const cols = await this.query.collections(actor.accountId);
    ctx.session.scratch = { ...ctx.session.scratch, [PICK_KEY]: { materialId, ids: cols.map((c) => c.id) } };
    const kb = new InlineKeyboard();
    cols
      .slice(0, 20)
      .forEach((c, i) =>
        kb.text(`📚 ${clip(c.title, 30)}`, sectionCb('materials', 'tocolok', ...shortRef(c.id, i))).row(),
      );
    kb.text(ctx.t('btn-new-collection'), sectionCb('materials', 'newcol')).row();
    kb.text(ctx.t('btn-back'), sectionCb('materials', 'm', materialId));
    await renderMenu(ctx, ctx.t('collections-list'), kb);
  }

  private async addToCollection(
    ctx: BotContext,
    actor: Actor,
    index?: string,
    check?: string,
  ): Promise<void> {
    const pick = ctx.session.scratch?.[PICK_KEY] as { materialId: string; ids: string[] } | undefined;
    const collectionId = pick ? resolveRef(pick.ids, index, check, (x) => x) : null;
    if (!pick || !collectionId) return this.open(ctx, actor);
    await this.materials.addToCollection(actor, collectionId, pick.materialId);
    await ctx.answerCallbackQuery({ text: ctx.t('collection-item-added') }).catch(() => undefined);
    await this.collectionCard(ctx, actor, collectionId);
  }

  private async collections(ctx: BotContext, actor: Actor): Promise<void> {
    const cols = await this.query.collections(actor.accountId);
    const kb = new InlineKeyboard();
    for (const c of cols.slice(0, 20))
      kb.text(`📚 ${clip(c.title, 32)}`, sectionCb('materials', 'col', c.id)).row();
    kb.text(ctx.t('btn-new-collection'), sectionCb('materials', 'newcol')).row();
    kb.text(ctx.t('btn-back'), sectionCb('materials', 'list'));
    await renderMenu(ctx, ctx.t(cols.length > 0 ? 'collections-list' : 'collections-empty'), kb);
  }

  private async collectionCard(ctx: BotContext, actor: Actor, collectionId: string): Promise<void> {
    const card = await this.query.collectionCard(actor.accountId, collectionId);
    const c = card.collection;
    const kb = new InlineKeyboard();
    for (const m of card.materials.slice(0, 20))
      kb.text(`${KIND_ICON[m.kind]} ${clip(m.title, 32)}`, sectionCb('materials', 'm', m.id)).row();
    kb.text(ctx.t('btn-collection-add'), sectionCb('materials', 'coladd', c.id))
      .text(ctx.t('btn-grant'), sectionCb('materials', 'grant', 'c', c.id))
      .row();
    kb.text(ctx.t('btn-back'), sectionCb('materials', 'cols'));
    const period = c.periodFrom
      ? ctx.t('collection-period', { from: c.periodFrom, to: c.periodTo ?? '…' })
      : '';
    const items = card.materials
      .map((m, i) => `${i + 1}. ${KIND_ICON[m.kind]} ${escapeHtml(m.title)}`)
      .join('\n');
    await renderMenu(
      ctx,
      ctx.t('collection-card', { title: escapeHtml(c.title), period, count: card.materials.length, items }),
      kb,
    );
  }

  /** 5.9.3 «Через занятие»: what is attached and the two «выдать» buttons. */
  private async lessonMaterials(ctx: BotContext, actor: Actor, lessonId: string): Promise<void> {
    const view = await this.lessons.teacherLesson(actor.accountId, lessonId);
    const attached = await this.materials.listForLesson(actor, lessonId);
    const zone = ctx.actor?.account.timezone ?? 'UTC';
    const when = formatInZone(view.lesson.startsAt, zone, 'dd.MM HH:mm');
    const items = attached
      .map((a) => ctx.t('lesson-material-line', { release: a.release, title: escapeHtml(a.title) }))
      .join('\n');
    const kb = new InlineKeyboard()
      .text(ctx.t('btn-attach-before'), sectionCb('materials', 'attach', lessonId, 'before'))
      .text(ctx.t('btn-attach-after'), sectionCb('materials', 'attach', lessonId, 'after'))
      .row()
      .text(ctx.t('btn-back'), sectionCb('today', 'lesson', lessonId));
    await renderMenu(
      ctx,
      ctx.t(attached.length > 0 ? 'lesson-materials' : 'lesson-materials-empty', { when, items }),
      kb,
    );
  }

  /** A material picker shared by «в подборку» and «выдать через занятие»; the target lives in the session. */
  private async pickMaterial(
    ctx: BotContext,
    actor: Actor,
    target: { collectionId: string } | { lessonId: string; release: Release },
  ): Promise<void> {
    const items = await this.query.list(actor.accountId);
    ctx.session.scratch = { ...ctx.session.scratch, [PICK_KEY]: { target, ids: items.map((m) => m.id) } };
    const kb = new InlineKeyboard();
    items
      .slice(0, 20)
      .forEach((m, i) =>
        kb
          .text(
            `${KIND_ICON[m.kind]} ${clip(m.title, 30)}`,
            sectionCb('materials', 'pick', ...shortRef(m.id, i)),
          )
          .row(),
      );
    const back =
      'collectionId' in target
        ? sectionCb('materials', 'col', target.collectionId)
        : sectionCb('materials', 'lesson', target.lessonId);
    kb.text(ctx.t('btn-back'), back);
    const text =
      'collectionId' in target
        ? ctx.t('pick-material', {
            title: escapeHtml(
              (await this.query.collectionCard(actor.accountId, target.collectionId)).collection.title,
            ),
          })
        : ctx.t('pick-material-lesson', { release: target.release });
    await renderMenu(ctx, text, kb);
  }

  private async picked(ctx: BotContext, actor: Actor, index?: string, check?: string): Promise<void> {
    const pick = ctx.session.scratch?.[PICK_KEY] as
      | { target: { collectionId: string } | { lessonId: string; release: Release }; ids: string[] }
      | undefined;
    const materialId = pick ? resolveRef(pick.ids, index, check, (x) => x) : null;
    if (!pick?.target || !materialId) return this.open(ctx, actor);
    if ('collectionId' in pick.target) {
      await this.materials.addToCollection(actor, pick.target.collectionId, materialId);
      await ctx.answerCallbackQuery({ text: ctx.t('collection-item-added') }).catch(() => undefined);
      return this.collectionCard(ctx, actor, pick.target.collectionId);
    }
    await this.materials.attachToLesson(actor, pick.target.lessonId, { materialId }, pick.target.release);
    await ctx.answerCallbackQuery({ text: ctx.t('lesson-material-attached') }).catch(() => undefined);
    await this.lessonMaterials(ctx, actor, pick.target.lessonId);
  }
}
