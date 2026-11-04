import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import type { Bot } from '@modules/identity/schema.js';
import {
  notification,
  type NotificationRoute,
  type NotificationRow,
  type NotificationStatus,
} from './schema.js';

export interface NewNotification {
  typeCode: string;
  recipientId: string;
  bot: Bot;
  payload: Record<string, unknown>;
  dedupeKey: string;
  dueAt: Date;
  ccOfId?: string | null;
  route?: NotificationRoute | null;
  forAccountId?: string | null;
}

@Injectable()
export class NotificationRepository {
  constructor(private readonly txm: TransactionManager) {}

  /** Idempotent by dedupe_key (NTF-08): returns null when an equal notification already exists. */
  async insert(data: NewNotification): Promise<NotificationRow | null> {
    const rows = await this.txm.db
      .insert(notification)
      .values({
        ...data,
        id: newId(),
        ccOfId: data.ccOfId ?? null,
        route: data.route ?? null,
        forAccountId: data.forAccountId ?? null,
      })
      .onConflictDoNothing({ target: notification.dedupeKey })
      .returning();
    return rows[0] ?? null;
  }

  /** Cheap existence check by dedupe key (the digest job skips the heavy queries once it is sent). */
  async existsByKey(dedupeKey: string): Promise<boolean> {
    const rows = await this.txm.db
      .select({ id: notification.id })
      .from(notification)
      .where(eq(notification.dedupeKey, dedupeKey))
      .limit(1);
    return rows.length > 0;
  }

  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<NotificationRow | null> {
    const query = this.txm.db.select().from(notification).where(eq(notification.id, id)).limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  /** Due notifications locked for this scheduler run (`FOR UPDATE SKIP LOCKED`). */
  async lockDue(now: Date, limit: number): Promise<NotificationRow[]> {
    return this.txm.db
      .select()
      .from(notification)
      .where(and(eq(notification.status, 'scheduled'), lte(notification.dueAt, now)))
      .orderBy(asc(notification.dueAt), asc(notification.id))
      .limit(limit)
      .for('update', { skipLocked: true });
  }

  /** `error` is kept unless explicitly replaced, so a later status change does not wipe the diagnosis. */
  async setStatus(
    ids: string[],
    status: NotificationStatus,
    patch: { error?: string | null; sentAt?: Date } = {},
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.txm.db
      .update(notification)
      .set({
        status,
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.sentAt ? { sentAt: patch.sentAt } : {}),
      })
      .where(inArray(notification.id, ids));
  }

  async bumpAttempts(id: string, error: string): Promise<void> {
    await this.txm.db
      .update(notification)
      .set({ attempts: sql`${notification.attempts} + 1`, error: error.slice(0, 500) })
      .where(eq(notification.id, id));
  }

  /** Rows stuck in `sending` (process died mid-send) or `queued` (Redis job lost) go back to `scheduled`. */
  async requeueStuck(limits: { sendingBefore: Date; queuedBefore: Date }): Promise<number> {
    const rows = await this.txm.db
      .update(notification)
      .set({ status: 'scheduled' })
      .where(
        sql`(${notification.status} = 'sending' AND ${notification.updatedAt} < ${limits.sendingBefore})
         OR (${notification.status} = 'queued' AND ${notification.updatedAt} < ${limits.queuedBefore})`,
      )
      .returning({ id: notification.id });
    return rows.length;
  }

  /**
   * Cancels not-yet-sent notifications by dedupe-key prefix (NTF-05: reminders of a cancelled lesson). With a
   * person given, their own rows *and* the copies / stand-in rows about them (`for_account_id`) are cancelled.
   */
  async cancelByPrefix(prefix: string, aboutAccountId?: string): Promise<number> {
    const rows = await this.txm.db
      .update(notification)
      .set({ status: 'cancelled' })
      .where(
        and(
          inArray(notification.status, ['scheduled', 'queued']),
          sql`starts_with(${notification.dedupeKey}, ${prefix})`,
          aboutAccountId
            ? or(eq(notification.recipientId, aboutAccountId), eq(notification.forAccountId, aboutAccountId))
            : undefined,
        ),
      )
      .returning({ id: notification.id });
    return rows.length;
  }

  async listForRecipient(recipientId: string, limit = 20): Promise<NotificationRow[]> {
    return this.txm.db
      .select()
      .from(notification)
      .where(eq(notification.recipientId, recipientId))
      .orderBy(asc(notification.createdAt))
      .limit(limit);
  }
}
