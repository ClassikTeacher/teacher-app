import { describe, expect, it } from 'vitest';
import { computeOpenSlots } from './slots.js';
import { computeWindows, isInsideWindows, minutesToTime, timeToMinutes } from './windows.js';

const utc = (iso: string) => new Date(iso);
const minsk = { zone: 'Europe/Minsk' };

describe('availability windows (5.5.4, CAL-05)', () => {
  const weekdays = [1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    startMin: 15 * 60,
    endMin: 20 * 60,
    validFrom: null,
    validTo: null,
  }));

  it('expands weekly rules in the teacher zone and applies closed days, closed intervals and extra windows', () => {
    const windows = computeWindows({
      ...minsk,
      rules: [
        ...weekdays,
        { weekday: 6, startMin: 10 * 60, endMin: 14 * 60, validFrom: null, validTo: null },
      ],
      exceptions: [
        { date: '2026-10-21', kind: 'closed', startMin: null, endMin: null }, // Wednesday off
        { date: '2026-10-22', kind: 'closed', startMin: 17 * 60, endMin: 18 * 60 }, // Thursday: a gap
        { date: '2026-10-25', kind: 'extra', startMin: 12 * 60, endMin: 13 * 60 }, // Sunday: one extra hour
      ],
      range: { start: utc('2026-10-19T00:00:00Z'), end: utc('2026-10-26T00:00:00Z') },
    });
    const text = windows.map((w) => `${w.start.toISOString()}–${w.end.toISOString()}`);
    expect(text).toEqual([
      '2026-10-19T12:00:00.000Z–2026-10-19T17:00:00.000Z', // Mon 15–20 Minsk (+3)
      '2026-10-20T12:00:00.000Z–2026-10-20T17:00:00.000Z',
      '2026-10-22T12:00:00.000Z–2026-10-22T14:00:00.000Z', // Thu before the gap
      '2026-10-22T15:00:00.000Z–2026-10-22T17:00:00.000Z', // Thu after the gap
      '2026-10-23T12:00:00.000Z–2026-10-23T17:00:00.000Z',
      '2026-10-24T07:00:00.000Z–2026-10-24T11:00:00.000Z', // Sat 10–14
      '2026-10-25T09:00:00.000Z–2026-10-25T10:00:00.000Z', // Sun extra
    ]);
    expect(
      isInsideWindows(windows, { start: utc('2026-10-19T13:00:00Z'), end: utc('2026-10-19T14:00:00Z') }),
    ).toBe(true);
    expect(
      isInsideWindows(windows, { start: utc('2026-10-19T16:30:00Z'), end: utc('2026-10-19T17:30:00Z') }),
    ).toBe(false);
  });

  it('keeps wall-clock times across DST (Berlin: spring forward 29.03.2026, fall back 25.10.2026)', () => {
    const berlin = computeWindows({
      zone: 'Europe/Berlin',
      rules: [{ weekday: 7, startMin: 9 * 60, endMin: 12 * 60, validFrom: null, validTo: null }],
      exceptions: [],
      range: { start: utc('2026-03-28T00:00:00Z'), end: utc('2026-03-30T00:00:00Z') },
    });
    // Sunday 29.03: 09:00–12:00 CEST (+2) = 07:00–10:00Z (the day before it would be +1)
    expect(berlin.map((w) => [w.start.toISOString(), w.end.toISOString()])).toEqual([
      ['2026-03-29T07:00:00.000Z', '2026-03-29T10:00:00.000Z'],
    ]);
    const gap = computeWindows({
      zone: 'Europe/Berlin',
      rules: [{ weekday: 7, startMin: 2 * 60, endMin: 4 * 60, validFrom: null, validTo: null }],
      exceptions: [],
      range: { start: utc('2026-03-29T00:00:00Z'), end: utc('2026-03-30T00:00:00Z') },
    });
    // 02:00 does not exist: the window starts at 03:00 CEST (= 01:00Z) and still ends at 04:00 CEST (02:00Z)
    expect(gap.map((w) => [w.start.toISOString(), w.end.toISOString()])).toEqual([
      ['2026-03-29T01:00:00.000Z', '2026-03-29T02:00:00.000Z'],
    ]);
    const fall = computeWindows({
      zone: 'Europe/Berlin',
      rules: [{ weekday: 7, startMin: 1 * 60, endMin: 24 * 60, validFrom: null, validTo: null }],
      exceptions: [],
      range: { start: utc('2026-10-24T22:00:00Z'), end: utc('2026-10-26T00:00:00Z') },
    });
    // 25.10 is a 25-hour day: 01:00 CEST (23:00Z of the 24th) until midnight CET (23:00Z of the 25th)
    expect(fall.map((w) => [w.start.toISOString(), w.end.toISOString()])).toEqual([
      ['2026-10-24T23:00:00.000Z', '2026-10-25T23:00:00.000Z'],
    ]);
  });

  it('honours rule validity and converts times', () => {
    const windows = computeWindows({
      ...minsk,
      rules: [
        { weekday: 1, startMin: 10 * 60, endMin: 11 * 60, validFrom: '2026-10-26', validTo: '2026-11-02' },
      ],
      exceptions: [],
      range: { start: utc('2026-10-19T00:00:00Z'), end: utc('2026-11-10T00:00:00Z') },
    });
    expect(windows.map((w) => w.start.toISOString())).toEqual([
      '2026-10-26T07:00:00.000Z',
      '2026-11-02T07:00:00.000Z',
    ]);
    expect(timeToMinutes('15:30:00')).toBe(930);
    expect(minutesToTime(930)).toBe('15:30:00');
  });

  it('computes open slots: windows − teacher busy (with the new lesson buffers) − student busy, on the grid; 3 weeks in < 300 ms', () => {
    const range = { start: utc('2026-10-19T00:00:00Z'), end: utc('2026-11-09T00:00:00Z') };
    const windows = computeWindows({ ...minsk, rules: weekdays, exceptions: [], range });
    const teacherBusy = Array.from({ length: 60 }, (_, i) => {
      const day = 19 + Math.floor(i / 4);
      const h = 15 + (i % 4);
      return {
        start: utc(`2026-10-${String(day).padStart(2, '0')}T${String(h - 3).padStart(2, '0')}:00:00Z`),
        end: utc(`2026-10-${String(day).padStart(2, '0')}T${String(h - 3).padStart(2, '0')}:45:00Z`),
      };
    }).filter((i) => !Number.isNaN(i.start.getTime()));
    const started = performance.now();
    const slots = computeOpenSlots({
      windows,
      teacherBusy,
      bufferBeforeMin: 10,
      bufferAfterMin: 10,
      studentBusy: [{ start: utc('2026-10-20T13:00:00Z'), end: utc('2026-10-20T14:00:00Z') }],
      gridStepMin: 30,
      durationMin: 60,
      range,
      zone: 'Europe/Minsk',
    });
    expect(performance.now() - started).toBeLessThan(300);
    expect(slots.length).toBeGreaterThan(0);
    // Monday 19.10: lessons 15:00–15:45 … 18:00–18:45 with 10-minute buffers leave no 60-minute slot before 18:55 → 19:00 fits? 19:00–20:00 yes
    expect(
      slots.filter((s) => s.start.toISOString().startsWith('2026-10-19')).map((s) => s.start.toISOString()),
    ).toEqual(['2026-10-19T16:00:00.000Z']);
    // every slot starts on the half hour in Minsk and lies inside a window
    expect(slots.every((s) => s.start.getUTCMinutes() % 30 === 0 && isInsideWindows(windows, s))).toBe(true);
  });
});
