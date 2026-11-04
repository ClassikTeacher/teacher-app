import { describe, expect, it } from 'vitest';
import { SecretBox } from './secret-box.js';

const KEY = 'a'.repeat(64);

describe('SecretBox (AES-256-GCM, 10.1)', () => {
  it('round-trips and never repeats the ciphertext', () => {
    const box = new SecretBox(KEY);
    const a = box.seal('1//refresh-token');
    const b = box.seal('1//refresh-token');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1.')).toBe(true);
    expect(box.open(a)).toBe('1//refresh-token');
    expect(box.open(b)).toBe('1//refresh-token');
  });

  it('rejects tampering, truncation and another key', () => {
    const box = new SecretBox(KEY);
    const sealed = box.seal('secret');
    const parts = sealed.split('.');
    const flipped = [...parts.slice(0, 3), `${parts[3]!.slice(0, -2)}AA`].join('.');
    expect(() => box.open(flipped)).toThrow();
    expect(() => box.open('v1.abc')).toThrow();
    expect(() => box.open(sealed.replace('v1.', 'v9.'))).toThrow();
    expect(() => new SecretBox('b'.repeat(64)).open(sealed)).toThrow();
    expect(() => new SecretBox('short')).toThrow();
  });
});
