import { Injectable, Logger } from '@nestjs/common';
import { type Api, GrammyError, InputFile } from 'grammy';
import type { Message } from 'grammy/types';
import { AppError } from '@shared/errors/app-error.js';
import type { Bot } from '@modules/identity/schema.js';
import { FileRepository } from './file.repository.js';
import { FileStorage, SIGNED_URL_TTL_SECONDS } from './file-storage.js';
import type { FileRow } from './schema.js';

/** Telegram albums hold two to ten items. */
export const ALBUM_MAX = 10;

type Sent = Message.DocumentMessage | { document?: { file_id: string; file_unique_id: string } };

export interface DeliveryReport {
  sent: number;
  /** Files withheld: still being scanned or infected (HW-05). */
  skipped: FileRow[];
}

/** Telegram refuses an unknown or foreign `file_id` with a 400; everything else is not the cache's fault. */
const isBadFileId = (error: unknown): boolean =>
  error instanceof GrammyError &&
  error.error_code === 400 &&
  /file|wrong|identifier/i.test(error.description);

/**
 * Sends stored files through a bot (5.9.4, 5.10.4): the per-bot `file_id` cache first, otherwise the bytes
 * from S3; the `file_id` Telegram returns is cached for that bot (7.5). Files that did not pass the antivirus
 * are never delivered (HW-05); pending ones wait. Signed links go through the same gate.
 */
@Injectable()
export class FileDeliveryService {
  private readonly logger = new Logger(FileDeliveryService.name);

  constructor(
    private readonly files: FileRepository,
    private readonly storage: FileStorage,
  ) {}

  /** Throws CONFLICT (`scan_pending` / `infected`) when the file must not be delivered yet or at all. */
  assertDeliverable(file: FileRow): void {
    if (file.status === 'deleted') throw AppError.notFound('file', file.id);
    if (file.scanStatus === 'infected')
      throw new AppError('CONFLICT', 'The file failed the antivirus check', { reason: 'infected' });
    if (file.scanStatus === 'pending')
      throw new AppError('CONFLICT', 'The file is still being scanned', { reason: 'scan_pending' });
  }

  isDeliverable(file: FileRow): boolean {
    return file.status !== 'deleted' && (file.scanStatus === 'clean' || file.scanStatus === 'skipped');
  }

  /** 5.9.4: a one-hour download link (for files the bot cannot send); gated like a send. */
  async downloadUrl(file: FileRow, ttlSeconds = SIGNED_URL_TTL_SECONDS): Promise<string> {
    this.assertDeliverable(file);
    return this.storage.signedUrl(file.key, file.originalName, ttlSeconds);
  }

  async send(api: Api, bot: Bot, chatId: number, file: FileRow, caption?: string): Promise<void> {
    this.assertDeliverable(file);
    const cached = await this.files.findCache(file.id, bot);
    const options = caption ? { caption, parse_mode: 'HTML' as const } : {};
    if (cached) {
      try {
        await api.sendDocument(chatId, cached.telegramFileId, options);
        return;
      } catch (error) {
        if (!isBadFileId(error)) throw error;
        await this.files.dropCache(file.id, bot); // a stale id (token rotated, file purged): re-upload once
      }
    }
    const sent = (await api.sendDocument(chatId, await this.input(file), options)) as Sent;
    await this.remember(file, bot, sent);
  }

  /**
   * Several files as albums of documents (UC-28 step 2); more than ten → several albums, never an album of one.
   * Withheld files are reported, not silently dropped.
   */
  async sendMany(
    api: Api,
    bot: Bot,
    chatId: number,
    files: readonly FileRow[],
    caption?: string,
  ): Promise<DeliveryReport> {
    const deliverable = files.filter((f) => this.isDeliverable(f));
    const skipped = files.filter((f) => !this.isDeliverable(f));
    for (const [index, batch] of this.batches(deliverable).entries()) {
      const text = index === 0 ? caption : undefined;
      if (batch.length === 1) {
        await this.send(api, bot, chatId, batch[0]!, text);
        continue;
      }
      try {
        await this.sendAlbum(api, bot, chatId, batch, text, true);
      } catch (error) {
        if (!isBadFileId(error)) throw error;
        for (const f of batch) await this.files.dropCache(f.id, bot);
        await this.sendAlbum(api, bot, chatId, batch, text, false);
      }
    }
    return { sent: deliverable.length, skipped };
  }

  /** Splits so that no batch has a single item: 11 files → 9 + 2, not 10 + 1. */
  private batches(files: readonly FileRow[]): FileRow[][] {
    const out: FileRow[][] = [];
    let rest = [...files];
    while (rest.length > 0) {
      let take = Math.min(ALBUM_MAX, rest.length);
      if (rest.length - take === 1) take -= 1;
      out.push(rest.slice(0, take));
      rest = rest.slice(take);
    }
    return out;
  }

  private async sendAlbum(
    api: Api,
    bot: Bot,
    chatId: number,
    batch: readonly FileRow[],
    caption: string | undefined,
    useCache: boolean,
  ): Promise<void> {
    const media = [];
    for (const [j, f] of batch.entries()) {
      const cached = useCache ? await this.files.findCache(f.id, bot) : null;
      media.push({
        type: 'document' as const,
        media: cached ? cached.telegramFileId : await this.input(f),
        ...(j === 0 && caption ? { caption, parse_mode: 'HTML' as const } : {}),
      });
    }
    const sent = (await api.sendMediaGroup(chatId, media)) as Sent[];
    for (const [j, f] of batch.entries()) {
      const message = sent[j];
      if (message) await this.remember(f, bot, message);
    }
  }

  private async input(file: FileRow): Promise<InputFile> {
    return new InputFile(await this.storage.getBytes(file.key), file.originalName);
  }

  /** Only ids of document messages are cached: a photo id cannot be re-sent as a document. */
  private async remember(file: FileRow, bot: Bot, sent: Sent): Promise<void> {
    const doc = sent.document;
    if (!doc?.file_id || !doc.file_unique_id) {
      this.logger.debug({ fileId: file.id, bot }, 'no document in the sent message; not cached');
      return;
    }
    await this.files.putCache(file.id, bot, doc.file_id, doc.file_unique_id);
  }
}
