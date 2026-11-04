import { Injectable } from '@nestjs/common';
import type { Api } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';

/** Bot API downloads are capped at 20 MB (4.1); larger files need the web upload of stage 2. */
export const TELEGRAM_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

export type FileTransport = (api: Api, fileId: string) => Promise<Buffer>;

const DOWNLOAD_TIMEOUT_MS = 60_000;

async function httpTransport(api: Api, fileId: string): Promise<Buffer> {
  const info = await api.getFile(fileId);
  if (!info.file_path) throw new AppError('FILE_TOO_LARGE', 'Telegram did not expose the file path');
  if ((info.file_size ?? 0) > TELEGRAM_DOWNLOAD_LIMIT_BYTES)
    throw new AppError('FILE_TOO_LARGE', 'File exceeds the Bot API limit');
  const response = await fetch(`https://api.telegram.org/file/bot${api.token}/${info.file_path}`, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`telegram file download failed: HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > TELEGRAM_DOWNLOAD_LIMIT_BYTES) throw new AppError('FILE_TOO_LARGE', 'File exceeds the limit');
  return Buffer.from(await response.arrayBuffer());
}

/** Fetches a file the user sent to a bot (7.5 «Файлы», step 1). The transport is replaceable in tests. */
@Injectable()
export class TelegramFileDownloader {
  transport: FileTransport = httpTransport;

  async download(api: Api, fileId: string): Promise<Buffer> {
    return this.transport(api, fileId);
  }
}
