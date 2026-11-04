import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Api } from 'grammy';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { type Actor, assertActive } from '@modules/access/actor.js';
import { FeatureService } from '@modules/access/features/feature.service.js';
import { AuditService } from '@modules/audit/audit.service.js';
import type { Bot } from '@modules/identity/schema.js';
import { FileTypeRepository } from '@modules/people/file-type.repository.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { FileRepository } from './file.repository.js';
import { FileStorage } from './file-storage.js';
import type { FileRow, ScanStatus } from './schema.js';
import { TELEGRAM_DOWNLOAD_LIMIT_BYTES, TelegramFileDownloader } from './telegram-file-downloader.js';
import { detectFileType, extensionOf } from './type-detector.js';
import { UploadRateLimit } from './upload-rate-limit.js';
import { VirusScanner } from './virus-scanner.js';

export interface TelegramFileInput {
  fileId: string;
  fileUniqueId: string;
  fileName?: string | null;
  size?: number | null;
  /** Only a document's `file_id` can be re-sent as a document; photo ids are not cached (7.5). */
  isDocument?: boolean;
}

export interface IngestInput {
  /** Who sends the file (teacher, student or parent). */
  actor: Actor;
  /** Whose storage quota is charged (Р-27): the teacher of the material or of the assignment. */
  ownerTeacherId: string;
  bot: Bot;
  api: Api;
  telegram: TelegramFileInput;
  /** Extra restriction of the assignment rules (5.10.1), a subset of the platform list. */
  allowedExts?: readonly string[] | null;
}

export const MAX_FILE_NAME_LENGTH = 200;

/**
 * 7.5 «Файлы»: Telegram → download → type by signature (HW-01) → antivirus (HW-05, pluggable) → S3 → row.
 * Size and quota are the owner teacher's `storage` limits; students carry only the protective limits of
 * HW-07. The row starts as `draft` and is attached by the material / submission that uses it.
 */
@Injectable()
export class IngestFileUseCase {
  private readonly logger = new Logger(IngestFileUseCase.name);

  constructor(
    private readonly txm: TransactionManager,
    private readonly files: FileRepository,
    private readonly fileTypes: FileTypeRepository,
    private readonly links: TeacherStudentRepository,
    private readonly storage: FileStorage,
    private readonly downloader: TelegramFileDownloader,
    private readonly scanner: VirusScanner,
    private readonly rate: UploadRateLimit,
    private readonly features: FeatureService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async execute(input: IngestInput): Promise<FileRow> {
    assertActive(input.actor);
    await this.features.assertEnabled(input.ownerTeacherId, 'storage');
    const [maxBytesLimit, quota] = await Promise.all([
      this.features.limit(input.ownerTeacherId, 'storage', 'maxFileBytes'),
      this.features.limit(input.ownerTeacherId, 'storage', 'quotaBytes'),
    ]);
    const maxBytes = Math.min(maxBytesLimit ?? TELEGRAM_DOWNLOAD_LIMIT_BYTES, TELEGRAM_DOWNLOAD_LIMIT_BYTES);
    const declared = input.telegram.size ?? 0;
    if (declared > maxBytes) throw new AppError('FILE_TOO_LARGE', 'File exceeds the limit', { maxBytes });
    const isOwner = input.actor.accountId === input.ownerTeacherId;
    if (!isOwner) {
      // 8.0: only a current student of the teacher may charge that teacher's storage
      const link = await this.links.findByPair(input.ownerTeacherId, input.actor.accountId);
      if (link?.status !== 'active')
        throw new AppError('LINK_NOT_ACTIVE', 'No active link with the teacher', { reason: 'not_linked' });
      const decision = await this.rate.acquire(input.actor.accountId); // HW-07: every attempt counts
      if (!decision.allowed)
        throw new AppError('UPLOAD_RATE_LIMIT', 'Too many uploads', { window: decision.window });
    }
    if (quota !== null && (await this.files.usedBytes(input.ownerTeacherId)) + Math.max(declared, 1) > quota)
      throw this.quotaError(input.ownerTeacherId);

    const bytes = await this.downloader.download(input.api, input.telegram.fileId);
    if (bytes.length === 0) throw AppError.validation('Empty file');
    if (bytes.length > maxBytes) throw new AppError('FILE_TOO_LARGE', 'File exceeds the limit', { maxBytes });
    const detected = await detectFileType(bytes);
    const allowed = await this.fileTypes.listAllowed();
    const allowedExts = allowed
      .map((t) => t.ext)
      .filter((ext) => !input.allowedExts || input.allowedExts.includes(ext));
    if (!detected || !allowedExts.includes(detected.ext)) {
      throw new AppError('FILE_TYPE_NOT_ALLOWED', 'File type is not accepted', {
        ext: detected?.ext ?? extensionOf(input.telegram.fileName) ?? null,
        allowed: allowedExts,
      });
    }
    const scan = await this.scanner.scan(bytes);
    if (scan.result === 'infected') {
      this.logger.warn({ by: input.actor.accountId, detail: scan.detail }, 'infected upload rejected');
      throw new AppError('FILE_REJECTED', 'The file failed the antivirus check');
    }
    const scanStatus: ScanStatus = scan.result === 'unavailable' ? 'pending' : scan.result;
    return this.store(input, bytes, detected.ext, detected.mime, scanStatus, scan.detail, isOwner, quota);
  }

  /** S3 first, then the row in one transaction; a failed transaction removes the object again. */
  private async store(
    input: IngestInput,
    bytes: Buffer,
    ext: string,
    mime: string,
    scanStatus: ScanStatus,
    scanDetail: string | null,
    isOwner: boolean,
    quota: number | null,
  ): Promise<FileRow> {
    const now = this.clock.now();
    const key = this.storage.newKey(input.ownerTeacherId, now);
    await this.storage.put(key, bytes, mime);
    try {
      return await this.txm.run(async () => {
        if (!(await this.files.reserve(input.ownerTeacherId, bytes.length, quota)))
          throw this.quotaError(input.ownerTeacherId);
        const file = await this.files.insert({
          bucket: this.storage.bucket,
          key,
          originalName: this.nameFor(input.telegram.fileName, ext),
          ext,
          mime,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          scanStatus,
          scanError: scanStatus === 'pending' ? scanDetail : null,
          uploadedBy: input.actor.accountId,
          ownerTeacherId: input.ownerTeacherId,
          createdAt: now,
        });
        if (input.telegram.isDocument)
          await this.files.putCache(file.id, input.bot, input.telegram.fileId, input.telegram.fileUniqueId);
        await this.audit.record({
          actorId: input.actor.accountId,
          actorRole: isOwner ? 'TEACHER' : (input.actor.roles[0] ?? null),
          action: 'file.uploaded',
          entityType: 'file',
          entityId: file.id,
          after: { ext, size: bytes.length, scanStatus, ownerTeacherId: input.ownerTeacherId },
          source: input.actor.source,
          ip: input.actor.ip,
        });
        return file;
      });
    } catch (error) {
      await this.storage
        .delete(key)
        .catch((e: unknown) => this.logger.warn({ err: e, key }, 'orphan object'));
      throw error;
    }
  }

  private quotaError(ownerTeacherId: string): AppError {
    return new AppError('STORAGE_QUOTA_EXCEEDED', 'The teacher storage is full', {
      // the id is for logs and the teacher's own warning; bots show the student a generic text (UC-27)
      ownerTeacherId,
    });
  }

  /** The user's name trimmed to a sane length; a photo has none, so a generic one with the detected extension. */
  private nameFor(name: string | null | undefined, ext: string): string {
    const clean = (name ?? '')
      .replace(/[^\p{L}\p{N}\p{P}\p{S} ]/gu, '_')
      .replace(/[/\\]/g, '_')
      .replace(/^\.+/, '')
      .trim();
    if (!clean) return `file.${ext}`;
    if (clean.length <= MAX_FILE_NAME_LENGTH) return clean;
    return `${clean.slice(0, MAX_FILE_NAME_LENGTH - ext.length - 2)}….${ext}`;
  }
}
