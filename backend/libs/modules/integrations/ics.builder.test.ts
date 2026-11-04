import { describe, expect, it } from 'vitest';
import { buildIcs, escapeIcsText, foldLine, icsDate } from './ics.builder.js';

describe('ICS builder (5.14.2)', () => {
  it('writes instants in UTC and escapes text', () => {
    expect(icsDate(new Date('2026-03-29T01:30:00Z'))).toBe('20260329T013000Z');
    expect(escapeIcsText('a, b; c\\ d\nновая')).toBe('a\\, b\\; c\\\\ d\\nновая');
  });

  it('folds long lines at 75 octets without splitting multibyte characters', () => {
    const line = `SUMMARY:${'Математика — Анна Петровна '.repeat(5)}`;
    const folded = foldLine(line);
    for (const part of folded.split('\r\n')) expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(75);
    expect(
      folded
        .split('\r\n')
        .slice(1)
        .every((p) => p.startsWith(' ')),
    ).toBe(true);
    expect(folded.replace(/\r\n /g, '')).toBe(line);
    expect(foldLine('short')).toBe('short');
  });

  it('builds a calendar with one VEVENT per lesson and CRLF line ends', () => {
    const text = buildIcs(
      'Занятия',
      [
        {
          uid: 'l1@tutor',
          start: new Date('2026-11-05T10:00:00Z'),
          end: new Date('2026-11-05T11:00:00Z'),
          summary: 'Математика — Анна Петровна',
          description: 'Онлайн',
          sequence: 2,
        },
      ],
      new Date('2026-11-04T12:00:00Z'),
    );
    expect(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(text).toContain('UID:l1@tutor\r\n');
    expect(text).toContain('DTSTART:20261105T100000Z\r\nDTEND:20261105T110000Z\r\n');
    expect(text).toContain('SUMMARY:Математика — Анна Петровна\r\n');
    expect(text).toContain('SEQUENCE:2\r\nSTATUS:CONFIRMED\r\nDESCRIPTION:Онлайн\r\n');
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });
});
