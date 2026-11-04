import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import { MaterialsUseCase, MAX_TITLE_LENGTH } from '@modules/content/materials.use-case.js';
import { IngestFileUseCase, type TelegramFileInput } from '@modules/files/ingest-file.use-case.js';
import type { BotContext } from '../../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../../core/flow.js';
import { mediaOf, UPLOADABLE_KINDS } from '../../core/media.js';
import { escapeHtml, renderMenu, say } from '../../core/ui.js';
import { isTerminalFlowError } from '../common/flow-errors.js';
import { sectionCb } from '../section-module.js';
import { GrantFlow } from './grant.flow.js';

export interface UploadMaterialData extends Record<string, unknown> {
  /** Stored file (draft) once the upload succeeded. */
  fileId: string | null;
  fileName: string | null;
  title: string | null;
  /** A file sent outside any dialog starts the flow with the file already in hand. */
  preset?: TelegramFileInput;
  /** Album id of the file taken: the other items of the same album are ignored (one material per dialog). */
  mediaGroupId?: string | null;
}

/**
 * UC-25 (5.9.1 «Загрузка в StaffBot»): send a file → name it → the material is in the library; then the
 * grant dialog is offered right away («кому выдать»).
 */
@Injectable()
export class UploadMaterialFlow extends Flow<UploadMaterialData> {
  readonly name = 'upload-material';
  readonly firstStep = 'file';

  constructor(
    private readonly ingest: IngestFileUseCase,
    private readonly materials: MaterialsUseCase,
    private readonly grantFlow: GrantFlow,
  ) {
    super();
  }

  async initial(_ctx: BotContext, arg: unknown): Promise<UploadMaterialData> {
    const start = arg as { file?: TelegramFileInput; mediaGroupId?: string | null } | undefined;
    return {
      fileId: null,
      fileName: null,
      title: null,
      preset: start?.file,
      mediaGroupId: start?.mediaGroupId ?? null,
    };
  }

  override async start(ctx: BotContext, arg?: unknown): Promise<void> {
    const data = await this.initial(ctx, arg);
    ctx.session.flow = { name: this.name, step: 'file', data, startedAt: Date.now() };
    if (data.preset) {
      const next = await this.store(ctx, data, data.preset);
      if ('goto' in next) {
        await this.steps[next.goto]!.enter(ctx, data);
        ctx.session.flow.step = next.goto;
      }
      return;
    }
    await this.steps.file!.enter(ctx, data);
  }

  private back(ctx: BotContext): InlineKeyboard {
    return new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('materials', 'list'));
  }

  private async store(ctx: BotContext, d: UploadMaterialData, file: TelegramFileInput): Promise<FlowNext> {
    if (!ctx.actor) return { stay: true };
    try {
      const row = await this.ingest.execute({
        actor: ctx.actor.actor,
        ownerTeacherId: ctx.actor.actor.accountId,
        bot: 'staff',
        api: ctx.api,
        telegram: file,
      });
      d.fileId = row.id;
      d.fileName = row.originalName;
      delete d.preset;
      return { goto: 'title' };
    } catch (error) {
      if (AppError.is(error, 'FILE_TYPE_NOT_ALLOWED')) {
        const allowed = ((error.details?.['allowed'] as string[] | undefined) ?? []).map((e) =>
          e.toUpperCase(),
        );
        await say(
          ctx,
          ctx.t('upload-type-refused', {
            ext: escapeHtml(typeof error.details?.['ext'] === 'string' ? error.details['ext'] : '?'),
            allowed: allowed.join(', '),
          }),
        );
        return { stay: true };
      }
      if (AppError.is(error, 'FILE_TOO_LARGE')) {
        await say(
          ctx,
          ctx.t('upload-too-large', {
            max: Math.round(Number(error.details?.['maxBytes'] ?? 0) / 1024 / 1024),
          }),
        );
        return { stay: true };
      }
      if (isTerminalFlowError(error)) ctx.session.flow = undefined;
      throw error;
    }
  }

  readonly steps: Record<string, FlowStep<UploadMaterialData>> = {
    file: {
      enter: async (ctx) =>
        renderMenu(
          ctx,
          ctx.t('upload-ask-file'),
          new InlineKeyboard().text(ctx.t('btn-cancel'), flowCb('file', 'cancel')),
        ),
      onCallback: async (ctx, _d, action) => {
        if (action !== 'cancel') return { stay: true };
        ctx.session.flow = undefined;
        await renderMenu(ctx, ctx.t('cancel-done'), this.back(ctx));
        return { stay: true };
      },
      onMedia: async (ctx, d, message) => {
        const media = mediaOf(message);
        if (!media || !UPLOADABLE_KINDS.includes(media.kind)) {
          await say(ctx, ctx.t('upload-kind-refused'));
          return { stay: true };
        }
        if (media.kind === 'photo') await say(ctx, ctx.t('upload-photo-hint'));
        d.mediaGroupId = media.mediaGroupId;
        return this.store(ctx, d, media.file);
      },
    },
    title: {
      // the rest of an album arrives while the title is asked: silently skipped (one material per dialog)
      onMedia: async (ctx, d, message) => {
        if (message.media_group_id && message.media_group_id === d.mediaGroupId) return { stay: true };
        await say(ctx, ctx.t('upload-one-at-a-time'));
        return { stay: true };
      },
      enter: async (ctx, d) =>
        renderMenu(
          ctx,
          ctx.t('upload-ask-title', { name: escapeHtml(d.fileName ?? '') }),
          new InlineKeyboard()
            .text(ctx.t('btn-keep-file-name'), flowCb('title', 'keep'))
            .text(ctx.t('btn-cancel'), flowCb('title', 'cancel')),
        ),
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') {
          ctx.session.flow = undefined; // the draft file is collected by the GC within 24 h (HW-06)
          await renderMenu(ctx, ctx.t('cancel-done'), this.back(ctx));
          return { stay: true };
        }
        if (action !== 'keep') return { stay: true };
        d.title =
          (d.fileName ?? '').replace(/\.[A-Za-z0-9]{1,10}$/, '').slice(0, MAX_TITLE_LENGTH) || d.fileName;
        return { done: true };
      },
      onText: async (ctx, d, text) => {
        if (!text || text.length > MAX_TITLE_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_TITLE_LENGTH }));
          return { stay: true };
        }
        d.title = text;
        return { done: true };
      },
    },
  };

  async complete(ctx: BotContext, d: UploadMaterialData): Promise<void> {
    if (!ctx.actor || !d.fileId || !d.title) {
      ctx.session.flow = undefined;
      return;
    }
    const row = await this.materials.create(ctx.actor.actor, {
      kind: 'file',
      title: d.title,
      fileId: d.fileId,
    });
    ctx.session.flow = undefined; // the material exists: a failure below must not retry `create`
    await say(ctx, ctx.t('upload-done', { title: escapeHtml(row.title) }));
    // straight into «кому выдать» (5.9.1); «Позже» leaves the material in the library
    await this.grantFlow.start(ctx, {
      subjectType: 'material',
      subjectId: row.id,
      title: row.title,
      optional: true,
    });
  }
}
