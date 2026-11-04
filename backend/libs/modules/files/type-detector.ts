import { fileTypeFromBuffer } from 'file-type';

export interface DetectedType {
  /** Lower-case extension as in `file_type.ext`. */
  ext: string;
  mime: string;
}

/** `file-type` names a few formats differently from the platform list (5.10.3). */
const EXT_ALIASES: Record<string, string> = { jpeg: 'jpg' };

/** Stream names inside an OLE (`cfb`) container tell legacy Office formats apart; anything else stays unknown. */
const OLE_STREAMS: Array<[string, DetectedType]> = [
  ['WordDocument', { ext: 'doc', mime: 'application/msword' }],
  ['Workbook', { ext: 'xls', mime: 'application/vnd.ms-excel' }],
  ['PowerPoint Document', { ext: 'ppt', mime: 'application/vnd.ms-powerpoint' }],
];

function oleType(bytes: Uint8Array): DetectedType | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const [stream, type] of OLE_STREAMS) if (buffer.includes(Buffer.from(stream, 'utf16le'))) return type;
  return null;
}

const TEXT_SAMPLE = 8 * 1024;

/** True when the sample looks like text: valid UTF-8 without control bytes other than tab, CR, LF. */
function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const sample = bytes.subarray(0, TEXT_SAMPLE);
  for (const b of sample) {
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b < 0x20 || b === 0x7f) return false;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(
      // a multi-byte sequence cut at the sample edge must not count as invalid
      sample.length === bytes.length ? sample : sample.subarray(0, sample.length - 4),
    );
    return true;
  } catch {
    return false;
  }
}

function startsWith(bytes: Uint8Array, ascii: string): boolean {
  if (bytes.length < ascii.length) return false;
  for (let i = 0; i < ascii.length; i += 1) if (bytes[i] !== ascii.charCodeAt(i)) return false;
  return true;
}

/**
 * HW-01: the type comes from the content, never from the name. Binary formats are detected by signature
 * (`file-type`: images, PDF, Office/ODF containers, audio, video, archives); RTF and plain text, which have
 * no magic bytes `file-type` knows, get small heuristics of their own. Unknown content → null.
 */
export async function detectFileType(bytes: Uint8Array): Promise<DetectedType | null> {
  if (startsWith(bytes, '{\\rtf')) return { ext: 'rtf', mime: 'application/rtf' };
  const found = await fileTypeFromBuffer(bytes);
  if (found) {
    if (found.ext === 'cfb') return oleType(bytes);
    return { ext: EXT_ALIASES[found.ext] ?? found.ext, mime: found.mime };
  }
  if (looksLikeText(bytes)) return { ext: 'txt', mime: 'text/plain' };
  return null;
}

/** Extension of a name as users see it (`Отчёт.PDF` → `pdf`), or null. Used only for messages, never for rules. */
export function extensionOf(name: string | null | undefined): string | null {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(name ?? '');
  return match ? match[1]!.toLowerCase() : null;
}
