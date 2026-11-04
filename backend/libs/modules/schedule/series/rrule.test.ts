import { describe, expect, it } from 'vitest';
import { expandSeries, formatRRule, parseRRule } from './rrule.js';

describe('series RRULE (7.5): storage format and Luxon expansion', () => {
  it('formats and parses the weekly subset', () => {
    expect(formatRRule({ intervalWeeks: 1, weekdays: [3, 1] })).toBe('FREQ=WEEKLY;BYDAY=MO,WE');
    expect(formatRRule({ intervalWeeks: 2, weekdays: [6] })).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=SA');
    expect(parseRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=SA,MO')).toEqual({ intervalWeeks: 2, weekdays: [1, 6] });
    expect(() => parseRRule('FREQ=DAILY')).toThrow();
    expect(() => parseRRule('FREQ=WEEKLY;BYDAY=XX')).toThrow();
    expect(() => parseRRule('FREQ=WEEKLY;INTERVAL=9;BYDAY=MO')).toThrow();
  });

  it('keeps the wall-clock time across the autumn DST change and honours bounds, pauses and intervals', () => {
    const occurrences = expandSeries({
      rrule: 'FREQ=WEEKLY;BYDAY=TU,TH',
      zone: 'Europe/Berlin',
      startMin: 16 * 60,
      durationMin: 60,
      startsOn: '2026-10-20',
      endsOn: '2026-11-05',
      fromDate: '2026-10-01',
      toDate: '2026-12-31',
      pausedFrom: '2026-10-26',
      pausedTo: '2026-11-01',
    });
    expect(occurrences.map((o) => `${o.dateIso} ${o.during.start.toISOString()}`)).toEqual([
      '2026-10-20 2026-10-20T14:00:00.000Z', // CEST: 16:00 = 14:00Z
      '2026-10-22 2026-10-22T14:00:00.000Z',
      // 27.10 and 29.10 fall inside the pause
      '2026-11-03 2026-11-03T15:00:00.000Z', // CET after 25.10: 16:00 = 15:00Z
      '2026-11-05 2026-11-05T15:00:00.000Z',
    ]);
    const biweekly = expandSeries({
      rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO',
      zone: 'Europe/Minsk',
      startMin: 10 * 60,
      durationMin: 45,
      startsOn: '2026-10-19',
      endsOn: null,
      fromDate: '2026-10-19',
      toDate: '2026-11-20',
    });
    expect(biweekly.map((o) => o.dateIso)).toEqual(['2026-10-19', '2026-11-02', '2026-11-16']);
    expect(biweekly[0]!.during.end.toISOString()).toBe('2026-10-19T07:45:00.000Z');
  });

  it('moves a start inside the spring-forward gap to the first valid minute and keeps the duration', () => {
    const [sunday] = expandSeries({
      rrule: 'FREQ=WEEKLY;BYDAY=SU',
      zone: 'Europe/Berlin',
      startMin: 2 * 60 + 30,
      durationMin: 60,
      startsOn: '2026-03-29',
      endsOn: '2026-03-29',
      fromDate: '2026-03-01',
      toDate: '2026-04-30',
    });
    expect(sunday!.during.start.toISOString()).toBe('2026-03-29T01:30:00.000Z'); // 03:30 CEST
    expect(sunday!.during.end.toISOString()).toBe('2026-03-29T02:30:00.000Z');
  });
});
