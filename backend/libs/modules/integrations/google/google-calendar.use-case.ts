import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env, googleConfig } from '@shared/config/index.js';
import { SecretBox } from '@shared/crypto/secret-box.js';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { type Actor, assertActive, assertRole, primaryRole, SYSTEM_ACTOR } from '@modules/access/actor.js';
import { FeatureService } from '@modules/access/features/feature.service.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { NotificationService } from '@modules/notifications/notification.service.js';
import { ExternalBusyRepository } from '@modules/schedule/occupancy/external-busy.repository.js';
import type { GoogleConnectionRow } from '../schema.js';
import { GOOGLE_API, type GoogleApi, GoogleAuthError } from './google-api.js';
import { GoogleCalendarRepository } from './google-calendar.repository.js';
import {
  GOOGLE_STATE,
  GOOGLE_STATE_TTL_MS,
  googleAuthUrl,
  googleRedirectUri,
  hashGoogleState,
  hasRequiredScopes,
} from './google-oauth.js';

/** The name of the calendar the app creates in the teacher's account (5.14.1 «отдельный календарь»). */
export const APP_CALENDAR_NAME = 'Занятия (Tutor Platform)';
const MAX_BUSY_CALENDARS = 5;
const CALENDAR_ID = /^[A-Za-z0-9._%+@-]{1,254}$/;

export type GoogleStatus =
  | { configured: false; connected: false }
  | { configured: true; connected: false }
  | {
      configured: true;
      connected: true;
      status: GoogleConnectionRow['status'];
      email: string | null;
      importEnabled: boolean;
      exportEnabled: boolean;
      busyCalendarIds: string[];
      lastImportAt: Date | null;
      lastExportAt: Date | null;
      lastError: string | null;
    };

export interface GoogleSettingsPatch {
  importEnabled?: boolean;
  exportEnabled?: boolean;
  busyCalendarIds?: string[];
}

/**
 * UC-43 / 5.14.1: a teacher connects their Google account (OAuth 2.0 with the two calendar scopes), the platform
 * creates a dedicated calendar for the lessons and reads «busy» intervals of the chosen calendars. Tokens are
 * sealed with GOOGLE_TOKEN_KEY (10.1); disconnecting revokes the token, deletes the app calendar (best effort)
 * and drops the imported busy time. The feature `calendar.google` gates every teacher action (5.3.3).
 */
@Injectable()
export class GoogleCalendarUseCase {
  private readonly logger = new Logger(GoogleCalendarUseCase.name);
  private readonly box: SecretBox | null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(GOOGLE_API) private readonly google: GoogleApi,
    private readonly txm: TransactionManager,
    private readonly repo: GoogleCalendarRepository,
    private readonly accounts: AccountRepository,
    private readonly externalBusy: ExternalBusyRepository,
    private readonly features: FeatureService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {
    const cfg = googleConfig(env);
    this.box = cfg ? new SecretBox(cfg.tokenKeyHex) : null;
  }

  get configured(): boolean {
    return this.box !== null;
  }

  async status(actor: Actor): Promise<GoogleStatus> {
    assertActive(actor);
    assertRole(actor, 'TEACHER');
    await this.features.assertEnabled(actor.accountId, 'calendar.google');
    if (!this.configured) return { configured: false, connected: false };
    const row = await this.repo.findLive(actor.accountId);
    if (!row) return { configured: true, connected: false };
    return {
      configured: true,
      connected: true,
      status: row.status,
      email: row.googleEmail,
      importEnabled: row.importEnabled,
      exportEnabled: row.exportEnabled,
      busyCalendarIds: row.busyCalendarIds,
      lastImportAt: row.lastImportAt,
      lastExportAt: row.lastExportAt,
      lastError: row.lastError,
    };
  }

  /** The consent URL for the teacher; the `state` is one-time, hashed and bound to the account. */
  async connectUrl(actor: Actor): Promise<string> {
    assertActive(actor);
    assertRole(actor, 'TEACHER');
    await this.features.assertEnabled(actor.accountId, 'calendar.google');
    const cfg = this.requireConfig();
    const now = this.clock.now();
    const state = randomBytes(32).toString('base64url');
    await this.txm.run(async () => {
      await this.repo.insertState(
        actor.accountId,
        hashGoogleState(state),
        new Date(now.getTime() + GOOGLE_STATE_TTL_MS),
      );
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: primaryRole(actor),
        action: 'google.connect_started',
        entityType: 'account',
        entityId: actor.accountId,
        source: actor.source,
        ip: actor.ip,
      });
    });
    const existing = await this.repo.findLive(actor.accountId);
    return googleAuthUrl({
      clientId: cfg.clientId,
      redirectUri: googleRedirectUri(this.env.PUBLIC_BASE_URL),
      state,
      loginHint: existing?.googleEmail ?? null,
    });
  }

  /**
   * `GET /integrations/google/callback`: exchanges the code, creates the app calendar, stores the sealed tokens.
   * Public endpoint — the state is the only credential, so an unknown, expired or used one is NOT_FOUND
   * (nothing more is revealed). Reconnecting replaces the previous connection of the account.
   */
  async completeOAuth(state: string, code: string): Promise<{ accountId: string; email: string | null }> {
    if (!GOOGLE_STATE.test(state) || !code) throw AppError.notFound('state');
    this.requireConfig();
    const now = this.clock.now();
    const pending = await this.txm.run(async () => {
      const row = await this.repo.findStateForUpdate(hashGoogleState(state));
      if (!row || row.usedAt || row.expiresAt.getTime() <= now.getTime()) throw AppError.notFound('state');
      await this.repo.markStateUsed(row.id, now);
      return row;
    });
    const account = await this.accounts.findById(pending.accountId);
    if (!account || account.status !== 'active') throw AppError.notFound('state');
    await this.features.assertEnabled(account.id, 'calendar.google');
    const tokens = await this.google.exchangeCode(code, googleRedirectUri(this.env.PUBLIC_BASE_URL));
    if (!tokens.refreshToken)
      throw new AppError(
        'CONFLICT',
        'Google did not issue a refresh token: revoke the app access and retry',
        {
          reason: 'no_refresh_token',
        },
      );
    if (!hasRequiredScopes(tokens.scope)) {
      await this.google.revokeToken(tokens.refreshToken).catch(() => undefined);
      throw new AppError('VALIDATION_ERROR', 'Not all calendar permissions were granted', {
        reason: 'scopes_missing',
      });
    }
    const calendarId = await this.google.createCalendar(
      tokens.accessToken,
      APP_CALENDAR_NAME,
      account.timezone,
    );
    const box = this.box!;
    await this.txm.run(async () => {
      const previous = await this.repo.findLive(account.id, { forUpdate: true });
      if (previous) {
        await this.repo.update(previous.id, { revokedAt: now, status: 'revoked' });
        await this.teardown(previous, { deleteCalendar: true });
      }
      const row = await this.repo.insertConnection({
        accountId: account.id,
        googleEmail: tokens.email,
        refreshTokenEnc: box.seal(tokens.refreshToken!),
        accessTokenEnc: box.seal(tokens.accessToken),
        accessTokenExpiresAt: new Date(now.getTime() + tokens.expiresIn * 1000),
      });
      await this.repo.update(row.id, { calendarId, exportRequestedAt: now });
      await this.audit.record({
        actorId: account.id,
        actorRole: 'TEACHER',
        action: 'google.connected',
        entityType: 'google_calendar_connection',
        entityId: row.id,
        after: { email: tokens.email, replaced: previous?.id ?? null },
        source: 'web',
      });
      await this.notifications.schedule({
        type: 'google.connected',
        recipientId: account.id,
        payload: { email: tokens.email ? esc(tokens.email) : '—', calendar: esc(APP_CALENDAR_NAME) },
        dedupeKey: `google.connected:${row.id}`,
      });
    });
    return { accountId: account.id, email: tokens.email };
  }

  /** «Отключить»: revokes the token, removes the app calendar, forgets the imported busy time (5.14.1). */
  async disconnect(actor: Actor): Promise<void> {
    assertActive(actor);
    assertRole(actor, 'TEACHER');
    const now = this.clock.now();
    await this.txm.run(async () => {
      const row = await this.repo.findLive(actor.accountId, { forUpdate: true });
      if (!row) throw AppError.notFound('google connection');
      await this.repo.update(row.id, { revokedAt: now, status: 'revoked' });
      await this.teardown(row, { deleteCalendar: true });
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: primaryRole(actor),
        action: 'google.disconnected',
        entityType: 'google_calendar_connection',
        entityId: row.id,
        source: actor.source,
        ip: actor.ip,
      });
    });
  }

  /** Import/export toggles and the list of calendars whose busy time is read (`primary` + up to 4 ids). */
  async updateSettings(actor: Actor, patch: GoogleSettingsPatch): Promise<GoogleStatus> {
    assertActive(actor);
    assertRole(actor, 'TEACHER');
    await this.features.assertEnabled(actor.accountId, 'calendar.google');
    const now = this.clock.now();
    await this.txm.run(async () => {
      const row = await this.repo.findLive(actor.accountId, { forUpdate: true });
      if (!row) throw AppError.notFound('google connection');
      const ids = patch.busyCalendarIds
        ? [...new Set(patch.busyCalendarIds.map((s) => s.trim()).filter(Boolean))]
        : undefined;
      if (ids) {
        if (ids.length === 0 || ids.length > MAX_BUSY_CALENDARS)
          throw AppError.validation('1 to 5 calendars', { max: MAX_BUSY_CALENDARS });
        const bad = ids.find((id) => !CALENDAR_ID.test(id));
        if (bad) throw AppError.validation('Calendar id looks wrong', { id: bad });
      }
      const importEnabled = patch.importEnabled ?? row.importEnabled;
      const exportEnabled = patch.exportEnabled ?? row.exportEnabled;
      await this.repo.update(row.id, {
        importEnabled,
        exportEnabled,
        ...(ids ? { busyCalendarIds: ids } : {}),
        // re-read busy time and re-plan the export on the next tick
        lastImportAt: null,
        exportRequestedAt: now,
      });
      if (!importEnabled) await this.externalBusy.clear(actor.accountId, 'google');
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: primaryRole(actor),
        action: 'google.settings_changed',
        entityType: 'google_calendar_connection',
        entityId: row.id,
        before: {
          importEnabled: row.importEnabled,
          exportEnabled: row.exportEnabled,
          busyCalendarIds: row.busyCalendarIds,
        },
        after: { importEnabled, exportEnabled, busyCalendarIds: ids ?? row.busyCalendarIds },
        source: actor.source,
        ip: actor.ip,
      });
    });
    return this.status(actor);
  }

  /** «Синхронизировать сейчас»: the job picks the connection up on its next tick (within a minute). */
  async requestSync(actor: Actor): Promise<void> {
    assertActive(actor);
    assertRole(actor, 'TEACHER');
    await this.features.assertEnabled(actor.accountId, 'calendar.google');
    const now = this.clock.now();
    await this.txm.run(async () => {
      const row = await this.repo.findLive(actor.accountId, { forUpdate: true });
      if (!row) throw AppError.notFound('google connection');
      await this.repo.update(row.id, { lastImportAt: null, exportRequestedAt: now });
    });
  }

  // --- used by the sync service -------------------------------------------------------------------

  /** A valid access token of the connection, refreshed and re-sealed when it is about to expire. */
  async accessTokenOf(row: GoogleConnectionRow): Promise<string> {
    const box = this.requireBox();
    const now = this.clock.now();
    if (
      row.accessTokenEnc &&
      row.accessTokenExpiresAt &&
      row.accessTokenExpiresAt.getTime() - now.getTime() > 60_000
    )
      return box.open(row.accessTokenEnc);
    const fresh = await this.google.refreshAccessToken(box.open(row.refreshTokenEnc));
    await this.repo.update(row.id, {
      accessTokenEnc: box.seal(fresh.accessToken),
      accessTokenExpiresAt: new Date(now.getTime() + fresh.expiresIn * 1000),
    });
    return fresh.accessToken;
  }

  /** Google rejected the credentials: the connection waits for the teacher to reconnect (one notification). */
  async markAuthFailed(row: GoogleConnectionRow, error: GoogleAuthError): Promise<void> {
    const now = this.clock.now();
    await this.txm.run(async () => {
      await this.repo.update(row.id, { status: 'error', lastError: error.message.slice(0, 500) });
      await this.externalBusy.clear(row.accountId, 'google');
      await this.notifications.schedule({
        type: 'google.sync_failed',
        recipientId: row.accountId,
        dedupeKey: `google.sync_failed:${row.id}`,
        dueAt: now,
      });
      await this.audit.record({
        actorId: SYSTEM_ACTOR.accountId,
        actorRole: null,
        action: 'google.auth_failed',
        entityType: 'google_calendar_connection',
        entityId: row.id,
        after: { error: error.message.slice(0, 200) },
        source: 'system',
      });
    });
  }

  // --- internals ----------------------------------------------------------------------------------

  private requireConfig(): { clientId: string; clientSecret: string } {
    const cfg = googleConfig(this.env);
    if (!cfg) throw new AppError('INTEGRATION_NOT_CONFIGURED', 'Google OAuth client is not configured');
    return cfg;
  }

  private requireBox(): SecretBox {
    if (!this.box) throw new AppError('INTEGRATION_NOT_CONFIGURED', 'Google OAuth client is not configured');
    return this.box;
  }

  /** Best-effort cleanup in Google; local state is dropped regardless. */
  private async teardown(row: GoogleConnectionRow, options: { deleteCalendar: boolean }): Promise<void> {
    await this.externalBusy.clear(row.accountId, 'google');
    if (!this.box) return;
    let refresh: string;
    try {
      refresh = this.box.open(row.refreshTokenEnc);
    } catch {
      return;
    }
    try {
      if (options.deleteCalendar && row.calendarId) {
        const access = await this.google.refreshAccessToken(refresh);
        await this.google.deleteCalendar(access.accessToken, row.calendarId);
      }
    } catch (error) {
      this.logger.warn({ err: error, connection: row.id }, 'could not delete the app calendar in Google');
    }
    await this.google.revokeToken(refresh).catch((error: unknown) => {
      this.logger.warn({ err: error, connection: row.id }, 'could not revoke the Google token');
    });
  }
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
