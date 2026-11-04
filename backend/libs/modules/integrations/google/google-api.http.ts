import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env, googleConfig } from '@shared/config/index.js';
import type { Interval } from '@modules/schedule/schema.js';
import {
  type GoogleApi,
  GoogleApiError,
  GoogleAuthError,
  type GoogleEventInput,
  type GoogleTokens,
} from './google-api.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const TIMEOUT_MS = 15_000;

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

/** Google OAuth 2.0 and Calendar v3 over `fetch`; no SDK (one less dependency to audit, 10.1). */
@Injectable()
export class GoogleApiHttp implements GoogleApi {
  constructor(@Inject(ENV) private readonly env: Env) {}

  async exchangeCode(code: string, redirectUri: string): Promise<GoogleTokens> {
    const cfg = this.config();
    const body = await this.token({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    if (!body.access_token) throw new GoogleAuthError('no access token in the response');
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresIn: body.expires_in ?? 3600,
      scope: body.scope ?? '',
      email: body.id_token ? emailFromIdToken(body.id_token) : null,
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
    const cfg = this.config();
    const body = await this.token({
      refresh_token: refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: 'refresh_token',
    });
    if (!body.access_token) throw new GoogleAuthError('no access token in the response');
    return { accessToken: body.access_token, expiresIn: body.expires_in ?? 3600 };
  }

  async revokeToken(token: string): Promise<void> {
    await this.request('POST', `${REVOKE_URL}?token=${encodeURIComponent(token)}`, null, null, {
      tolerate: [400, 404],
    });
  }

  async createCalendar(accessToken: string, summary: string, timeZone: string): Promise<string> {
    const body = (await this.request('POST', `${CALENDAR_API}/calendars`, accessToken, {
      summary,
      timeZone,
    })) as { id?: string };
    if (!body.id) throw new GoogleApiError('calendar without id', null);
    return body.id;
  }

  async deleteCalendar(accessToken: string, calendarId: string): Promise<void> {
    await this.request(
      'DELETE',
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}`,
      accessToken,
      null,
      {
        tolerate: [404, 410],
      },
    );
  }

  async insertEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    event: GoogleEventInput,
  ): Promise<void> {
    try {
      await this.request(
        'POST',
        `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
        accessToken,
        { id: eventId, ...toGoogleEvent(event) },
      );
    } catch (error) {
      // 409: the id exists from an earlier run whose mapping was lost — the event is ours, overwrite it
      if (error instanceof GoogleApiError && error.status === 409)
        await this.updateEvent(accessToken, calendarId, eventId, event);
      else throw error;
    }
  }

  async updateEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    event: GoogleEventInput,
  ): Promise<void> {
    await this.request(
      'PUT',
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      accessToken,
      toGoogleEvent(event),
    );
  }

  async deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
    await this.request(
      'DELETE',
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      accessToken,
      null,
      { tolerate: [404, 410] },
    );
  }

  async freeBusy(accessToken: string, calendarIds: readonly string[], range: Interval): Promise<Interval[]> {
    const body = (await this.request('POST', `${CALENDAR_API}/freeBusy`, accessToken, {
      timeMin: range.start.toISOString(),
      timeMax: range.end.toISOString(),
      items: calendarIds.map((id) => ({ id })),
    })) as { calendars?: Record<string, { busy?: { start: string; end: string }[] }> };
    const out: Interval[] = [];
    for (const cal of Object.values(body.calendars ?? {})) {
      for (const b of cal.busy ?? []) {
        const start = new Date(b.start);
        const end = new Date(b.end);
        if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) out.push({ start, end });
      }
    }
    return out;
  }

  // --- internals ----------------------------------------------------------------------------------

  private config(): { clientId: string; clientSecret: string } {
    const cfg = googleConfig(this.env);
    if (!cfg) throw new GoogleApiError('Google OAuth client is not configured', null);
    return cfg;
  }

  private async token(form: Record<string, string>): Promise<TokenResponse> {
    let response: Response;
    try {
      response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new GoogleApiError(`token endpoint unreachable: ${String(error)}`, null);
    }
    const body = (await response.json().catch(() => ({}))) as TokenResponse;
    if (!response.ok) {
      // only invalid_grant is the teacher's grant (revoked consent, expired or reused code, password change);
      // invalid_client & co. are this installation's misconfiguration and must not park connections in `error`
      if (body.error === 'invalid_grant')
        throw new GoogleAuthError(`invalid_grant: ${body.error_description ?? ''}`.trim());
      throw new GoogleApiError(
        `token endpoint ${response.status}: ${body.error ?? ''} ${body.error_description ?? ''}`.trim(),
        response.status,
      );
    }
    return body;
  }

  private async request(
    method: string,
    url: string,
    accessToken: string | null,
    json: unknown,
    options: { tolerate?: number[] } = {},
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          ...(json !== null ? { 'Content-Type': 'application/json' } : {}),
        },
        body: json !== null ? JSON.stringify(json) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new GoogleApiError(`Google unreachable: ${String(error)}`, null);
    }
    if (options.tolerate?.includes(response.status)) return {};
    if (response.status === 401) throw new GoogleAuthError('access token rejected');
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new GoogleApiError(`Google ${method} ${response.status}: ${text.slice(0, 200)}`, response.status);
    }
    if (response.status === 204) return {};
    return response.json().catch(() => ({}));
  }
}

function toGoogleEvent(event: GoogleEventInput): Record<string, unknown> {
  return {
    summary: event.summary,
    description: event.description ?? undefined,
    location: event.location ?? undefined,
    start: { dateTime: event.start.toISOString() },
    end: { dateTime: event.end.toISOString() },
    extendedProperties: { private: event.extendedPrivate },
    reminders: { useDefault: true },
  };
}

/** Reads `email` from the JWT payload without verifying the signature (see GoogleTokens.email). */
export function emailFromIdToken(idToken: string): string | null {
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: unknown };
    return typeof parsed.email === 'string' ? parsed.email : null;
  } catch {
    return null;
  }
}
