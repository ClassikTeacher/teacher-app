import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import { IngestFileUseCase } from '@modules/files/ingest-file.use-case.js';
import { StorageWarningUseCase } from '@modules/files/storage-warning.use-case.js';
import { MAX_SUBMISSION_TEXT_LENGTH } from '@modules/homework/homework.rules.js';
import type { SubmissionMode } from '@modules/homework/schema.js';
import { SubmitUseCase } from '@modules/homework/submit.use-case.js';
import type { BotContext } from '../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../core/flow.js';
import { mediaOf, UPLOADABLE_KINDS } from '../core/media.js';
import { type SectionModule, sectionCb } from '../core/sections.js';
import { escapeHtml, renderMenu, say } from '../core/ui.js';

export interface SubmitPreset {
  assignmentId: string;
  teacherId: string;
  title: string;
  mode: SubmissionMode;
  allowedExts: string[] | null;
  maxFiles: number;
}

export interface SubmitData extends Record<string, unknown>, SubmitPreset {
  fileIds: string[];
  fileNames: string[];
  texts: string[];
  photoHintShown: boolean;
}

/**
 * UC-27 (5.10.3): files, photos, album items and texts arrive as separate messages and pile up in the
 * draft; «Готово» shows the preview, «Отправить» hands it in. HW-03 hints once about «как файл»; the errors
 * of UC-27 (type, size, rate, quota) are explained in place and the draft survives them.
 */
@Injectable()
export class SubmitFlow extends Flow<SubmitData> {
  readonly name = 'submit';
  readonly firstStep = 'collect';

  constructor(
    private readonly ingest: IngestFileUseCase,
    private readonly submit: SubmitUseCase,
    private readonly storageWarning: StorageWarningUseCase,
  ) {
    super();
  }

  async initial(_ctx: BotContext, arg: unknown): Promise<SubmitData> {
    return { ...(arg as SubmitPreset), fileIds: [], fileNames: [], texts: [], photoHintShown: false };
  }

  private back(ctx: BotContext, d: SubmitData): InlineKeyboard {
    return new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('assignments', 'a', d.assignmentId));
  }

  private async cancel(ctx: BotContext, d: SubmitData): Promise<FlowNext> {
    ctx.session.flow = undefined; // draft files are collected by the GC within 24 h (HW-06)
    await renderMenu(ctx, ctx.t('cancel-done'), this.back(ctx, d));
    return { stay: true };
  }

  private acceptsFiles(d: SubmitData): boolean {
    return d.mode === 'files' || d.mode === 'files_text';
  }

  private acceptsText(d: SubmitData): boolean {
    return d.mode === 'text' || d.mode === 'files_text';
  }

  private summary(ctx: BotContext, d: SubmitData): string {
    return ctx.t('submit-summary', { files: d.fileIds.length, texts: d.texts.length });
  }

  readonly steps: Record<string, FlowStep<SubmitData>> = {
    collect: {
      enter: async (ctx, d) => {
        const kb = new InlineKeyboard();
        if (d.fileIds.length + d.texts.length > 0) kb.text(ctx.t('btn-done'), flowCb('collect', 'done'));
        kb.text(ctx.t('btn-cancel'), flowCb('collect', 'cancel'));
        const key =
          d.mode === 'text'
            ? 'submit-collect-text'
            : d.mode === 'files'
              ? 'submit-collect-files'
              : 'submit-collect';
        await renderMenu(ctx, `${ctx.t(key, { title: escapeHtml(d.title) })}\n${this.summary(ctx, d)}`, kb);
      },
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.cancel(ctx, d);
        if (action === 'done' && d.fileIds.length + d.texts.length > 0) return { goto: 'preview' };
        return { stay: true };
      },
      onText: async (ctx, d, text) => {
        if (!this.acceptsText(d)) {
          await say(ctx, ctx.t('submit-text-not-accepted'));
          return { stay: true };
        }
        const total = [...d.texts, text].join('\n\n');
        if (!text || total.length > MAX_SUBMISSION_TEXT_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_SUBMISSION_TEXT_LENGTH }));
          return { stay: true };
        }
        d.texts = [...d.texts, text];
        return { goto: 'collect' };
      },
      onMedia: async (ctx, d, message) => this.addFile(ctx, d, message),
    },
    preview: {
      enter: async (ctx, d) =>
        renderMenu(
          ctx,
          ctx.t('submit-preview', {
            title: escapeHtml(d.title),
            summary: this.summary(ctx, d),
            names: escapeHtml(d.fileNames.join(', ')),
          }),
          new InlineKeyboard()
            .text(ctx.t('btn-send-submission'), flowCb('preview', 'send'))
            .text(ctx.t('btn-add-more'), flowCb('preview', 'more'))
            .row()
            .text(ctx.t('btn-cancel'), flowCb('preview', 'cancel')),
        ),
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.cancel(ctx, d);
        if (action === 'more') return { goto: 'collect' };
        return action === 'send' ? { done: true } : { stay: true };
      },
    },
  };

  /** One more file into the draft; the UC-27 alternatives are explained and the draft is kept. */
  private async addFile(
    ctx: BotContext,
    d: SubmitData,
    message: NonNullable<BotContext['message']>,
  ): Promise<FlowNext> {
    if (!ctx.actor) return { stay: true };
    const media = mediaOf(message);
    if (!media || !UPLOADABLE_KINDS.includes(media.kind)) {
      await say(ctx, ctx.t(media?.kind === 'voice' ? 'submit-voice-later' : 'upload-kind-refused'));
      return { stay: true };
    }
    if (!this.acceptsFiles(d)) {
      await say(ctx, ctx.t('submit-files-not-accepted'));
      return { stay: true };
    }
    if (d.fileIds.length >= d.maxFiles) {
      await say(ctx, ctx.t('submit-too-many-files', { max: d.maxFiles }));
      return { stay: true };
    }
    if (media.kind === 'photo' && !d.photoHintShown) {
      d.photoHintShown = true;
      await say(ctx, ctx.t('upload-photo-hint')); // HW-03
    }
    try {
      const row = await this.ingest.execute({
        actor: ctx.actor.actor,
        ownerTeacherId: d.teacherId,
        bot: 'student',
        api: ctx.api,
        telegram: media.file,
        allowedExts: d.allowedExts,
      });
      d.fileIds = [...d.fileIds, row.id];
      d.fileNames = [...d.fileNames, row.originalName];
      // an album arrives as several updates: the menu is re-rendered once per item, which is fine
      return { goto: 'collect' };
    } catch (error) {
      if (AppError.is(error, 'FILE_TYPE_NOT_ALLOWED')) {
        const allowed = ((error.details?.['allowed'] as string[] | undefined) ?? []).map((e) =>
          e.toUpperCase(),
        );
        const ext = typeof error.details?.['ext'] === 'string' ? error.details['ext'] : '?';
        await say(ctx, ctx.t('upload-type-refused', { ext: escapeHtml(ext), allowed: allowed.join(', ') }));
        return { stay: true };
      }
      if (AppError.is(error, 'FILE_TOO_LARGE')) {
        const max = Math.round(Number(error.details?.['maxBytes'] ?? 0) / 1024 / 1024);
        await say(ctx, ctx.t('upload-too-large', { max }));
        return { stay: true };
      }
      if (AppError.is(error, 'STORAGE_QUOTA_EXCEEDED')) {
        await this.storageWarning.notifyFull(d.teacherId); // the teacher learns the storage is full (UC-27)
        await say(ctx, ctx.t('error-storage-quota-exceeded'));
        return { stay: true };
      }
      if (AppError.is(error, 'UPLOAD_RATE_LIMIT') || AppError.is(error, 'FILE_REJECTED')) {
        await say(ctx, ctx.t(`error-${error.code.toLowerCase().replace(/_/g, '-')}`));
        return { stay: true };
      }
      throw error;
    }
  }

  async complete(ctx: BotContext, d: SubmitData): Promise<void> {
    if (!ctx.actor) return;
    try {
      await this.submit.execute(ctx.actor.actor, {
        assignmentId: d.assignmentId,
        fileIds: d.fileIds,
        text: d.texts.join('\n\n') || null,
      });
      await renderMenu(ctx, ctx.t('submit-sent', { title: escapeHtml(d.title) }), this.back(ctx, d));
    } catch (error) {
      if (AppError.is(error, 'CONFLICT') || AppError.is(error, 'VALIDATION_ERROR')) {
        const raw = error.details?.['reason'];
        const reason = (typeof raw === 'string' ? raw : 'conflict').replace(/_/g, '-');
        ctx.session.flow = undefined;
        await renderMenu(
          ctx,
          ctx.t(`submit-refused-${reason}`, { title: escapeHtml(d.title) }),
          this.back(ctx, d),
        );
        return;
      }
      throw error;
    }
  }
}

/** Marker so the section module type is importable without a cycle. */
export type SubmitSectionModule = SectionModule<'assignments'>;
