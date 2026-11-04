import type { Message } from 'grammy/types';
import type { TelegramFileInput } from '@modules/files/ingest-file.use-case.js';

export type MediaKind = 'document' | 'photo' | 'audio' | 'video' | 'voice' | 'video_note' | 'sticker';

export interface IncomingMedia {
  kind: MediaKind;
  file: TelegramFileInput;
  /** Set when several photos arrived as one album (HW-02). */
  mediaGroupId: string | null;
  caption: string | null;
}

/**
 * The file behind a Telegram message, whatever the way it was sent. A photo is taken at its largest size;
 * Telegram re-encodes photos, so callers may hint «отправьте как файл» (HW-03). Voice and video notes are
 * recognised but refused by the callers in MVP (stage 2, Р-30).
 */
export function mediaOf(message: Message): IncomingMedia | null {
  const base = { mediaGroupId: message.media_group_id ?? null, caption: message.caption ?? null };
  if (message.document) {
    const d = message.document;
    return {
      ...base,
      kind: 'document',
      file: {
        fileId: d.file_id,
        fileUniqueId: d.file_unique_id,
        fileName: d.file_name ?? null,
        size: d.file_size ?? null,
        isDocument: true,
      },
    };
  }
  if (message.photo && message.photo.length > 0) {
    const p = [...message.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0]!;
    return {
      ...base,
      kind: 'photo',
      file: { fileId: p.file_id, fileUniqueId: p.file_unique_id, fileName: null, size: p.file_size ?? null },
    };
  }
  if (message.audio) {
    const a = message.audio;
    return {
      ...base,
      kind: 'audio',
      file: {
        fileId: a.file_id,
        fileUniqueId: a.file_unique_id,
        fileName: a.file_name ?? a.title ?? null,
        size: a.file_size ?? null,
      },
    };
  }
  if (message.video) {
    const v = message.video;
    return {
      ...base,
      kind: 'video',
      file: {
        fileId: v.file_id,
        fileUniqueId: v.file_unique_id,
        fileName: v.file_name ?? null,
        size: v.file_size ?? null,
      },
    };
  }
  if (message.voice) {
    const v = message.voice;
    return {
      ...base,
      kind: 'voice',
      file: { fileId: v.file_id, fileUniqueId: v.file_unique_id, size: v.file_size ?? null },
    };
  }
  if (message.video_note) {
    const v = message.video_note;
    return {
      ...base,
      kind: 'video_note',
      file: { fileId: v.file_id, fileUniqueId: v.file_unique_id, size: v.file_size ?? null },
    };
  }
  if (message.sticker) {
    const v = message.sticker;
    return {
      ...base,
      kind: 'sticker',
      file: { fileId: v.file_id, fileUniqueId: v.file_unique_id, size: v.file_size ?? null },
    };
  }
  return null;
}

/** Kinds the platform stores in MVP; everything else gets a polite refusal. */
export const UPLOADABLE_KINDS: readonly MediaKind[] = ['document', 'photo', 'audio', 'video'];
