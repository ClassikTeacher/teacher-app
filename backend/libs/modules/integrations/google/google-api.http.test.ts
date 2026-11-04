import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@shared/config/env.schema.js';
import { GoogleApiError, GoogleAuthError } from './google-api.js';
import { emailFromIdToken, GoogleApiHttp } from './google-api.http.js';

const env = {
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_TOKEN_KEY: 'a'.repeat(64),
} as unknown as Env;

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('GoogleApiHttp (fetch-based client)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('classifies token-endpoint errors: only invalid_grant is the teacher’s grant', async () => {
    const api = new GoogleApiHttp(env);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(400, { error: 'invalid_grant' })));
    await expect(api.refreshAccessToken('rt')).rejects.toBeInstanceOf(GoogleAuthError);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(401, { error: 'invalid_client' })));
    await expect(api.refreshAccessToken('rt')).rejects.toBeInstanceOf(GoogleApiError);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(503, {})));
    await expect(api.refreshAccessToken('rt')).rejects.toBeInstanceOf(GoogleApiError);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    await expect(api.refreshAccessToken('rt')).rejects.toBeInstanceOf(GoogleApiError);
  });

  it('exchanges a code, reads the e-mail from the id_token and sends the client secret as a form', async () => {
    const api = new GoogleApiHttp(env);
    const idToken = `h.${Buffer.from(JSON.stringify({ email: 'anna@gmail.com' })).toString('base64url')}.s`;
    const fetchMock = vi.fn().mockResolvedValue(
      respond(200, {
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 100,
        scope: 's',
        id_token: idToken,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const tokens = await api.exchangeCode('code', 'https://x/cb');
    expect(tokens).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresIn: 100,
      scope: 's',
      email: 'anna@gmail.com',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.body).toContain('client_secret=secret');
    expect(init.body).toContain('grant_type=authorization_code');
    expect(emailFromIdToken('garbage')).toBeNull();
  });

  it('treats a 401 on the Calendar API as a lost grant, 404/410 on delete as done, 409 on insert as update', async () => {
    const api = new GoogleApiHttp(env);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(401, {})));
    await expect(
      api.freeBusy('at', ['primary'], { start: new Date(), end: new Date() }),
    ).rejects.toBeInstanceOf(GoogleAuthError);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 410 })));
    await expect(api.deleteEvent('at', 'cal', 'ev')).resolves.toBeUndefined();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init: RequestInit) => {
        calls.push(`${init.method} ${url}`);
        return Promise.resolve(init.method === 'POST' ? respond(409, {}) : respond(200, { id: 'ev' }));
      }),
    );
    await api.insertEvent('at', 'cal id', 'ev', {
      summary: 'x',
      description: null,
      location: null,
      start: new Date('2026-11-10T10:00:00Z'),
      end: new Date('2026-11-10T11:00:00Z'),
      extendedPrivate: {},
    });
    expect(calls).toEqual([
      'POST https://www.googleapis.com/calendar/v3/calendars/cal%20id/events',
      'PUT https://www.googleapis.com/calendar/v3/calendars/cal%20id/events/ev',
    ]);
  });

  it('parses freebusy of several calendars and drops malformed entries', async () => {
    const api = new GoogleApiHttp(env);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        respond(200, {
          calendars: {
            primary: { busy: [{ start: '2026-11-09T12:00:00Z', end: '2026-11-09T13:00:00Z' }] },
            work: {
              busy: [
                { start: 'nope', end: '2026-11-09T13:00:00Z' },
                { start: '2026-11-09T14:00:00Z', end: '2026-11-09T15:00:00Z' },
              ],
            },
          },
        }),
      ),
    );
    const busy = await api.freeBusy('at', ['primary', 'work'], {
      start: new Date('2026-11-09T00:00:00Z'),
      end: new Date('2026-11-10T00:00:00Z'),
    });
    expect(busy).toEqual([
      { start: new Date('2026-11-09T12:00:00Z'), end: new Date('2026-11-09T13:00:00Z') },
      { start: new Date('2026-11-09T14:00:00Z'), end: new Date('2026-11-09T15:00:00Z') },
    ]);
  });
});
