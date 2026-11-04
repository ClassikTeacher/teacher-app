import type { Interval } from '../libs/modules/schedule/schema.js';
import {
  type GoogleApi,
  GoogleApiError,
  GoogleAuthError,
  type GoogleEventInput,
  type GoogleTokens,
} from '../libs/modules/integrations/google/google-api.js';

export const GOOGLE_TEST_ENV = {
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-secret',
  GOOGLE_TOKEN_KEY: '0123456789abcdef'.repeat(4),
};

interface FakeCalendar {
  summary: string;
  timeZone: string;
  events: Map<string, GoogleEventInput>;
}

/**
 * In-memory Google (OAuth + Calendar v3) for the integration tests: codes map to accounts, refresh tokens can be
 * revoked (then every call fails like `invalid_grant`), freebusy returns what the test sets per calendar id.
 */
export class FakeGoogleApi implements GoogleApi {
  readonly calendars = new Map<string, FakeCalendar>();
  readonly busy = new Map<string, Interval[]>();
  readonly revoked = new Set<string>();
  readonly calls: string[] = [];
  /** Codes issued by the "consent screen": code → account email and scopes. */
  readonly codes = new Map<string, { email: string; scope?: string; refreshToken?: string | null }>();
  /** Every network call fails with a GoogleApiError carrying this message (Google down) while set. */
  outage: Error | null = null;
  private seq = 0;
  private readonly refreshTokens = new Map<string, string>();

  exchangeCode(code: string, _redirectUri: string): Promise<GoogleTokens> {
    this.calls.push(`exchange:${code}`);
    const issued = this.codes.get(code);
    if (!issued) return Promise.reject(new GoogleAuthError('invalid_grant: bad code'));
    this.codes.delete(code);
    const refreshToken = issued.refreshToken === undefined ? `rt-${++this.seq}` : issued.refreshToken;
    if (refreshToken) this.refreshTokens.set(refreshToken, issued.email);
    return Promise.resolve({
      accessToken: `at-${++this.seq}`,
      refreshToken,
      expiresIn: 3600,
      scope:
        issued.scope ??
        'https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/calendar.freebusy openid email',
      email: issued.email,
    });
  }

  refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
    this.calls.push('refresh');
    this.check();
    if (this.revoked.has(refreshToken) || !this.refreshTokens.has(refreshToken))
      return Promise.reject(new GoogleAuthError('invalid_grant: Token has been expired or revoked.'));
    return Promise.resolve({ accessToken: `at-${++this.seq}`, expiresIn: 3600 });
  }

  revokeToken(token: string): Promise<void> {
    this.calls.push('revoke');
    this.revoked.add(token);
    return Promise.resolve();
  }

  createCalendar(_accessToken: string, summary: string, timeZone: string): Promise<string> {
    this.calls.push('createCalendar');
    this.check();
    const id = `cal-${++this.seq}@group.calendar.google.com`;
    this.calendars.set(id, { summary, timeZone, events: new Map() });
    return Promise.resolve(id);
  }

  deleteCalendar(_accessToken: string, calendarId: string): Promise<void> {
    this.calls.push('deleteCalendar');
    this.check();
    this.calendars.delete(calendarId);
    return Promise.resolve();
  }

  insertEvent(
    _accessToken: string,
    calendarId: string,
    eventId: string,
    event: GoogleEventInput,
  ): Promise<void> {
    this.calls.push(this.calendar(calendarId).events.has(eventId) ? 'insertEvent:exists' : 'insertEvent');
    this.check();
    this.calendar(calendarId).events.set(eventId, event);
    return Promise.resolve();
  }

  updateEvent(
    _accessToken: string,
    calendarId: string,
    eventId: string,
    event: GoogleEventInput,
  ): Promise<void> {
    this.calls.push('updateEvent');
    this.check();
    this.calendar(calendarId).events.set(eventId, event);
    return Promise.resolve();
  }

  deleteEvent(_accessToken: string, calendarId: string, eventId: string): Promise<void> {
    this.calls.push('deleteEvent');
    this.check();
    this.calendars.get(calendarId)?.events.delete(eventId);
    return Promise.resolve();
  }

  freeBusy(_accessToken: string, calendarIds: readonly string[], range: Interval): Promise<Interval[]> {
    this.calls.push(`freeBusy:${calendarIds.join(',')}`);
    this.check();
    const out: Interval[] = [];
    for (const id of calendarIds)
      for (const i of this.busy.get(id) ?? []) if (i.start < range.end && i.end > range.start) out.push(i);
    return Promise.resolve(out);
  }

  /** Refresh tokens handed out so far (to revoke one from the "Google side"). */
  issuedRefreshTokens(): string[] {
    return [...this.refreshTokens.keys()];
  }

  /** All events of the single app calendar (tests create one connection at a time). */
  eventsOf(calendarId: string): GoogleEventInput[] {
    return [...(this.calendars.get(calendarId)?.events.values() ?? [])];
  }

  private calendar(id: string): FakeCalendar {
    const cal = this.calendars.get(id);
    if (!cal) throw new Error(`fake google: unknown calendar ${id}`);
    return cal;
  }

  private check(): void {
    if (this.outage) throw new GoogleApiError(this.outage.message, 503);
  }
}
