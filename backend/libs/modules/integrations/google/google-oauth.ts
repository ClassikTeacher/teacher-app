import { createHash } from 'node:crypto';
import { GOOGLE_SCOPES } from './google-api.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_CALLBACK_PATH = '/api/v1/integrations/google/callback';
/** `state` must survive the consent screen: 15 minutes. */
export const GOOGLE_STATE_TTL_MS = 15 * 60_000;
export const GOOGLE_STATE = /^[A-Za-z0-9_-]{43}$/;

export function googleRedirectUri(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/$/, '')}${GOOGLE_CALLBACK_PATH}`;
}

export function hashGoogleState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

/** The consent URL (5.14.1): offline access for a refresh token, consent forced so the token is always issued. */
export function googleAuthUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  loginHint?: string | null;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: input.state,
  });
  if (input.loginHint) params.set('login_hint', input.loginHint);
  return `${AUTH_URL}?${params.toString()}`;
}

/** The consent must cover both calendar scopes; `openid email` are optional. */
export function hasRequiredScopes(granted: string): boolean {
  const set = new Set(granted.split(/\s+/).filter(Boolean));
  return GOOGLE_SCOPES.filter((s) => s.startsWith('https://')).every((s) => set.has(s));
}
