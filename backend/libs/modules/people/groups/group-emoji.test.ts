import { describe, expect, it } from 'vitest';
import { isValidGroupEmoji } from './group-emoji.js';

describe('isValidGroupEmoji (5.4.4)', () => {
  it('accepts single emoji incl. flags, keycaps, skin tones and ZWJ sequences', () => {
    for (const e of ['🔬', '🇧🇾', '1️⃣', '👍🏽', '👨‍👩‍👧', '❤️', ' 📚 ']) expect(isValidGroupEmoji(e), e).toBe(true);
  });

  it('rejects letters, digits, several emoji and empty input', () => {
    for (const e of ['ab', 'a', '12', '🔬📚', '', '   ', 'A🔬']) expect(isValidGroupEmoji(e), e).toBe(false);
  });
});
