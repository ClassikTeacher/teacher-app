/**
 * A group emoji is exactly one grapheme cluster that is pictographic: flags, keycaps, skin tones and ZWJ
 * families included, plain letters excluded (5.4.4 "цвет или эмодзи").
 */
const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export const MAX_EMOJI_LENGTH = 16;

export function isValidGroupEmoji(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_EMOJI_LENGTH) return false;
  const clusters = [...segmenter.segment(trimmed)];
  return clusters.length === 1 && PICTOGRAPHIC.test(trimmed);
}
