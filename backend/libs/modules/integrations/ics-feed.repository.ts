import { Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import { icsFeed, type IcsFeedRow } from './schema.js';

/** Persistence for ICS feed secrets. No rules here. */
@Injectable()
export class IcsFeedRepository {
  constructor(private readonly txm: TransactionManager) {}

  async findLive(accountId: string, options: { forUpdate?: boolean } = {}): Promise<IcsFeedRow | null> {
    const query = this.txm.db
      .select()
      .from(icsFeed)
      .where(and(eq(icsFeed.accountId, accountId), isNull(icsFeed.revokedAt)))
      .limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  /** A live feed by the hash of its token (a revoked one never resolves). */
  async findByTokenHash(tokenHash: string): Promise<IcsFeedRow | null> {
    const rows = await this.txm.db
      .select()
      .from(icsFeed)
      .where(and(eq(icsFeed.tokenHash, tokenHash), isNull(icsFeed.revokedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Transaction-scoped advisory lock serialising issue/rotate of one account. */
  async lockAccount(accountId: string): Promise<void> {
    await this.txm.db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ics:${accountId}`}))`);
  }

  async insert(accountId: string, tokenHash: string): Promise<IcsFeedRow> {
    const rows = await this.txm.db.insert(icsFeed).values({ id: newId(), accountId, tokenHash }).returning();
    return rows[0]!;
  }

  async revoke(id: string, at: Date): Promise<void> {
    await this.txm.db.update(icsFeed).set({ revokedAt: at }).where(eq(icsFeed.id, id));
  }
}
