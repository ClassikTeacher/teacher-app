import { describe, expect, it } from 'vitest';
import type { LessonView } from '@modules/schedule/lessons/lessons.query.js';
import { eventIdFor, eventOf, planExport, signatureOf } from './google-export.rules.js';
import { googleAuthUrl, hasRequiredScopes } from './google-oauth.js';

function view(id: string, overrides: Partial<LessonView['lesson']> = {}): LessonView {
  return {
    lesson: {
      id,
      startsAt: new Date('2026-11-10T10:00:00Z'),
      endsAt: new Date('2026-11-10T11:00:00Z'),
      format: 'online',
      meetingUrl: 'https://meet.example/x',
      location: null,
      plannedTopic: null,
      status: 'scheduled',
      ...overrides,
    } as LessonView['lesson'],
    participants: [{ displayName: 'Петя' } as LessonView['participants'][number]],
    group: null,
    subject: { name: 'Математика' } as LessonView['subject'],
  };
}

describe('Google export plan (5.14.1)', () => {
  it('builds a minimal event: subject, who, format, topic, link; no student contacts', () => {
    const event = eventOf(view('l1', { plannedTopic: 'Дроби' }));
    expect(event.summary).toBe('Математика — Петя');
    expect(event.description).toBe('Онлайн\nТема: Дроби\nhttps://meet.example/x');
    expect(event.location).toBeNull();
    expect(event.extendedPrivate).toEqual({ app: 'tutor-platform', lessonId: 'l1' });
    const inPerson = eventOf(view('l2', { format: 'in_person', location: 'ул. Ленина 1', meetingUrl: null }));
    expect(inPerson.location).toBe('ул. Ленина 1');
    expect(inPerson.description).toBe('Очно');
  });

  it('inserts new (deterministic id), updates changed, deletes gone, keeps out-of-window history, skips unchanged', () => {
    const a = view('a');
    const b = view('b');
    const bSig = signatureOf(eventOf(b));
    const gone = new Set(['c']);
    const ops = planExport(
      'conn',
      [a, b],
      [
        { lessonId: 'b', googleEventId: 'evB', signature: 'stale', deleted: false },
        { lessonId: 'c', googleEventId: 'evC', signature: 'x', deleted: false },
        { lessonId: 'd', googleEventId: 'evD', signature: 'x', deleted: true },
        // a completed lesson older than the window: not live, not gone → stays in the calendar
        { lessonId: 'old', googleEventId: 'evOld', signature: 'x', deleted: false },
      ],
      (id) => gone.has(id),
    );
    expect(ops.map((o) => `${o.op}:${o.lessonId}`)).toEqual(['insert:a', 'update:b', 'delete:c']);
    expect(ops[0]).toMatchObject({ googleEventId: eventIdFor('conn', 'a') });
    expect(eventIdFor('conn', 'a')).toMatch(/^[0-9a-v]{64}$/); // base32hex alphabet, Google's rule for ids
    expect(ops[1]).toMatchObject({ googleEventId: 'evB', signature: bSig });
    // second pass with fresh mappings: nothing to do
    expect(
      planExport(
        'conn',
        [a, b],
        [
          { lessonId: 'a', googleEventId: 'evA', signature: signatureOf(eventOf(a)), deleted: false },
          { lessonId: 'b', googleEventId: 'evB', signature: bSig, deleted: false },
        ],
        () => true,
      ),
    ).toEqual([]);
  });

  it('re-inserts a lesson whose event was deleted earlier (restored lesson)', () => {
    const ops = planExport(
      'conn',
      [view('a')],
      [{ lessonId: 'a', googleEventId: 'old', signature: 's', deleted: true }],
      () => true,
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op).toBe('insert');
  });
});

describe('Google OAuth helpers', () => {
  it('builds the consent URL with offline access and both calendar scopes', () => {
    const url = new URL(
      googleAuthUrl({ clientId: 'id', redirectUri: 'https://t.example/cb', state: 'st', loginHint: 'a@b.c' }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('login_hint')).toBe('a@b.c');
    expect(url.searchParams.get('scope')).toContain('calendar.app.created');
    expect(url.searchParams.get('scope')).toContain('calendar.freebusy');
  });

  it('requires both calendar scopes, not the identity ones', () => {
    expect(
      hasRequiredScopes(
        'https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/calendar.freebusy',
      ),
    ).toBe(true);
    expect(hasRequiredScopes('https://www.googleapis.com/auth/calendar.freebusy openid email')).toBe(false);
  });
});
