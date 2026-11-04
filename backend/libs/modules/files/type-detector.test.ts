import { describe, expect, it } from 'vitest';
import { detectFileType, extensionOf } from './type-detector.js';

const bytes = (...parts: Array<string | number[]>): Uint8Array =>
  Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));

describe('detectFileType (HW-01: by content, not by name)', () => {
  it('recognises PDF, PNG, JPEG and ZIP by their signatures', async () => {
    expect(await detectFileType(bytes('%PDF-1.7\n%âãÏÓ\n1 0 obj'))).toEqual({
      ext: 'pdf',
      mime: 'application/pdf',
    });
    expect(
      (
        await detectFileType(
          bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 'IHDR', new Array(32).fill(0)),
        )
      )?.ext,
    ).toBe('png');
    expect((await detectFileType(bytes([0xff, 0xd8, 0xff, 0xe0], new Array(32).fill(0))))?.ext).toBe('jpg');
    expect((await detectFileType(bytes([0x50, 0x4b, 0x03, 0x04], new Array(64).fill(0))))?.ext).toBe('zip');
  });

  it('detects RTF and plain text, which have no magic bytes', async () => {
    expect(await detectFileType(bytes('{\\rtf1\\ansi Hello}'))).toEqual({
      ext: 'rtf',
      mime: 'application/rtf',
    });
    expect(await detectFileType(Buffer.from('Домашнее задание №3\nРешить задачи 1–5.\n', 'utf8'))).toEqual({
      ext: 'txt',
      mime: 'text/plain',
    });
  });

  it('names an .exe by its content (refused later by the allow-list) and returns null for unknown bytes', async () => {
    expect(
      (await detectFileType(bytes([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00])))?.ext,
    ).toBe('exe');
    expect(await detectFileType(bytes([0x01, 0x02, 0x03, 0xfe, 0xff, 0x00, 0x7f, 0x80]))).toBeNull();
    expect(await detectFileType(new Uint8Array())).toBeNull();
  });

  it('extensionOf is for messages only', () => {
    expect(extensionOf('Отчёт.PDF')).toBe('pdf');
    expect(extensionOf('noext')).toBeNull();
    expect(extensionOf(null)).toBeNull();
  });
});
