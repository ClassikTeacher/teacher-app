import { describe, expect, it } from 'vitest';
import { cb, parseCb } from './callback.js';

describe('callback_data helpers', () => {
  it('round-trips namespace, action and args', () => {
    const data = cb('st', 'open', '019a0000-0000-7000-8000-000000000001', 2);
    expect(data.length).toBeLessThanOrEqual(64);
    expect(parseCb(data)).toEqual({
      ns: 'st',
      action: 'open',
      args: ['019a0000-0000-7000-8000-000000000001', '2'],
    });
  });

  it('rejects payloads over 64 bytes (Telegram limit)', () => {
    expect(() => cb('x', 'y', 'a'.repeat(70))).toThrow(/64 bytes/);
    expect(() => cb('x', 'y', 'я'.repeat(31))).toThrow(/64 bytes/);
  });

  it('returns null for malformed data', () => {
    expect(parseCb(undefined)).toBeNull();
    expect(parseCb('onlyns')).toBeNull();
  });
});
