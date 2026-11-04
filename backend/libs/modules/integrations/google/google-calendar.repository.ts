import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import {
  googleCalendarConnection,
  googleCalendarEvent,
  googleOauthState,
  type GoogleConnectionRow,
  type GoogleEventRow,
  type GoogleOauthStateRow,
} from '../schema.js';

export type ConnectionPatch = Partial<
  Pick<
    GoogleConnectionRow,
    | 'status'
    | 'googleEmail'
    | 'calendarId'
    | 'refreshTokenEnc'
    | 'accessTokenEnc'
    | 'accessTokenExpiresAt'
    | 'busyCalendarIds'
    | 'importEnabled'
    | 'exportEnabled'
    | 'lastImportAt'
    | 'lastExportAt'
    | 'exportRequestedAt'
    | 'lastError'
    | 'revokedAt'
  >
>;

/** Persistence for Google connections, event mappings and OAuth states. No rules here. */
@Injectable()
export class GoogleCalendarRepository {
  constructor(private readonly txm: TransactionManager) {}

  // --- connections ---------------------------------------------------------------------------------

  async findLive(
    accountId: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<GoogleConnectionRow | null> {
    const query = this.txm.db
      .select()
      .from(googleCalendarConnection)
      .where(
        and(eq(googleCalendarConnection.accountId, accountId), isNull(googleCalendarConnection.revokedAt)),
      )
      .limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<GoogleConnectionRow | null> {
    const query = this.txm.db
      .select()
      .from(googleCalendarConnection)
      .where(eq(googleCalendarConnection.id, id))
      .limit(1);
    const rows = options.forUpdate ? await query.for('update', { skipLocked: true }) : await query;
    return rows[0] ?? null;
  }

  async insertConnection(input: {
    accountId: string;
    googleEmail: string | null;
    refreshTokenEnc: string;
    accessTokenEnc: string;
    accessTokenExpiresAt: Date;
  }): Promise<GoogleConnectionRow> {
    const rows = await this.txm.db
      .insert(googleCalendarConnection)
      .values({ id: newId(), ...input })
      .returning();
    return rows[0]!;
  }

  async update(id: string, patch: ConnectionPatch): Promise<GoogleConnectionRow> {
    const rows = await this.txm.db
      .update(googleCalendarConnection)
      .set(patch)
      .where(eq(googleCalendarConnection.id, id))
      .returning();
    return rows[0]!;
  }

  /** Marks the live connection of a teacher as needing an export (lesson events). */
  async requestExport(accountId: string, at: Date): Promise<void> {
    await this.txm.db
      .update(googleCalendarConnection)
      .set({ exportRequestedAt: at })
      .where(
        and(
          eq(googleCalendarConnection.accountId, accountId),
          isNull(googleCalendarConnection.revokedAt),
          eq(googleCalendarConnection.status, 'active'),
        ),
      );
  }

  /** Live, working connections due for a sync: an export was requested, or the periodic interval passed. */
  async listDue(now: Date, intervalMs: number, limit: number): Promise<GoogleConnectionRow[]> {
    const stale = new Date(now.getTime() - intervalMs);
    return this.txm.db
      .select()
      .from(googleCalendarConnection)
      .where(
        and(
          isNull(googleCalendarConnection.revokedAt),
          eq(googleCalendarConnection.status, 'active'),
          or(
            // `>=`: a request at the very instant of the last export still counts (the plan is idempotent)
            sql`${googleCalendarConnection.exportRequestedAt} >= coalesce(${googleCalendarConnection.lastExportAt}, '-infinity'::timestamptz)`,
            isNull(googleCalendarConnection.lastImportAt),
            lte(googleCalendarConnection.lastImportAt, stale),
          ),
        ),
      )
      .orderBy(googleCalendarConnection.lastImportAt)
      .limit(limit);
  }

  // --- event mappings ------------------------------------------------------------------------------

  async listMappings(connectionId: string): Promise<GoogleEventRow[]> {
    return this.txm.db
      .select()
      .from(googleCalendarEvent)
      .where(eq(googleCalendarEvent.connectionId, connectionId));
  }

  async upsertMapping(input: {
    connectionId: string;
    lessonId: string;
    googleEventId: string;
    signature: string;
    at: Date;
  }): Promise<void> {
    await this.txm.db
      .insert(googleCalendarEvent)
      .values({
        id: newId(),
        connectionId: input.connectionId,
        lessonId: input.lessonId,
        googleEventId: input.googleEventId,
        signature: input.signature,
        syncedAt: input.at,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: [googleCalendarEvent.connectionId, googleCalendarEvent.lessonId],
        set: {
          googleEventId: input.googleEventId,
          signature: input.signature,
          syncedAt: input.at,
          deletedAt: null,
        },
      });
  }

  async markMappingDeleted(connectionId: string, lessonIds: readonly string[], at: Date): Promise<void> {
    if (lessonIds.length === 0) return;
    await this.txm.db
      .update(googleCalendarEvent)
      .set({ deletedAt: at, syncedAt: at })
      .where(
        and(
          eq(googleCalendarEvent.connectionId, connectionId),
          inArray(googleCalendarEvent.lessonId, [...lessonIds]),
        ),
      );
  }

  // --- OAuth state ---------------------------------------------------------------------------------

  async insertState(accountId: string, stateHash: string, expiresAt: Date): Promise<GoogleOauthStateRow> {
    const rows = await this.txm.db
      .insert(googleOauthState)
      .values({ id: newId(), accountId, stateHash, expiresAt })
      .returning();
    return rows[0]!;
  }

  /** Locks the row so two callbacks with the same code/state cannot both succeed. */
  async findStateForUpdate(stateHash: string): Promise<GoogleOauthStateRow | null> {
    const rows = await this.txm.db
      .select()
      .from(googleOauthState)
      .where(eq(googleOauthState.stateHash, stateHash))
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  async markStateUsed(id: string, at: Date): Promise<void> {
    await this.txm.db.update(googleOauthState).set({ usedAt: at }).where(eq(googleOauthState.id, id));
  }

  /** Housekeeping: spent and expired states are useless after a day. */
  async deleteExpiredStates(before: Date): Promise<number> {
    const rows = await this.txm.db
      .delete(googleOauthState)
      .where(lt(googleOauthState.expiresAt, before))
      .returning({ id: googleOauthState.id });
    return rows.length;
  }

  /** Transaction-scoped advisory lock: one sync of a connection at a time. */
  async lockConnection(connectionId: string): Promise<boolean> {
    const rows = await this.txm.db.execute<{ ok: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtext(${`google:${connectionId}`})) AS ok`,
    );
    return rows.rows[0]?.ok === true;
  }
}
