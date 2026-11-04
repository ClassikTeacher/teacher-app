import type { Interval } from '@modules/schedule/schema.js';

/** Scopes of 5.14.1 💡: only the app-created calendar and «busy» intervals; `openid email` names the account. */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.app.created',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'openid',
  'email',
] as const;

export interface GoogleTokens {
  accessToken: string;
  /** Google returns it only on the first consent (`access_type=offline&prompt=consent`). */
  refreshToken: string | null;
  expiresIn: number;
  scope: string;
  /** From the `id_token` (not verified: it arrives straight from Google over TLS). */
  email: string | null;
}

export interface GoogleEventInput {
  summary: string;
  description: string | null;
  location: string | null;
  start: Date;
  end: Date;
  /** `tutor-platform` marker, so the app can tell its own events apart. */
  extendedPrivate: Record<string, string>;
}

/** Google refused the credentials (`invalid_grant`, 401): the teacher has to connect again. */
export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

/** Any other Google failure (5xx, quota, network): retried on the next sync. */
export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

/** The slice of Google OAuth and the Calendar API the integration uses (5.14.1); tests inject a fake. */
export interface GoogleApi {
  exchangeCode(code: string, redirectUri: string): Promise<GoogleTokens>;
  refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }>;
  /** Best effort: a token that is already invalid is fine. */
  revokeToken(token: string): Promise<void>;
  createCalendar(accessToken: string, summary: string, timeZone: string): Promise<string>;
  deleteCalendar(accessToken: string, calendarId: string): Promise<void>;
  insertEvent(accessToken: string, calendarId: string, event: GoogleEventInput): Promise<string>;
  updateEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    event: GoogleEventInput,
  ): Promise<void>;
  /** A missing event (404/410) is not an error. */
  deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void>;
  /** Busy intervals of the given calendars (only times — the freebusy scope reveals nothing else). */
  freeBusy(accessToken: string, calendarIds: readonly string[], range: Interval): Promise<Interval[]>;
}

export const GOOGLE_API = Symbol('GOOGLE_API');
