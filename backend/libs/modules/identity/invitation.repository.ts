import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import { invitation, type InvitationKind, type InvitationPayload, type InvitationRow } from './schema.js';

export interface NewInvitation {
  tokenHash: string;
  kind: InvitationKind;
  createdBy: string | null;
  targetTelegramUserId: number | null;
  payload: InvitationPayload;
  maxUses: number;
  expiresAt: Date;
}

@Injectable()
export class InvitationRepository {
  constructor(private readonly txm: TransactionManager) {}

  async insert(data: NewInvitation): Promise<InvitationRow> {
    const rows = await this.txm.db
      .insert(invitation)
      .values({ ...data, id: newId() })
      .returning();
    return rows[0]!;
  }

  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<InvitationRow | null> {
    const query = this.txm.db.select().from(invitation).where(eq(invitation.id, id)).limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async findByIds(ids: readonly string[]): Promise<InvitationRow[]> {
    if (ids.length === 0) return [];
    return this.txm.db
      .select()
      .from(invitation)
      .where(inArray(invitation.id, [...ids]));
  }

  async findByTokenHash(
    tokenHash: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<InvitationRow | null> {
    const query = this.txm.db.select().from(invitation).where(eq(invitation.tokenHash, tokenHash)).limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async listByCreator(createdBy: string, limit = 50): Promise<InvitationRow[]> {
    return this.txm.db
      .select()
      .from(invitation)
      .where(eq(invitation.createdBy, createdBy))
      .orderBy(desc(invitation.createdAt))
      .limit(limit);
  }

  async listPendingByCreator(createdBy: string, now: Date): Promise<InvitationRow[]> {
    return this.txm.db
      .select()
      .from(invitation)
      .where(
        and(
          eq(invitation.createdBy, createdBy),
          eq(invitation.status, 'pending'),
          sql`${invitation.expiresAt} > ${now}`,
        ),
      )
      .orderBy(desc(invitation.createdAt));
  }

  /** Outstanding parent links of a student from every teacher (5.4.3 limit counts them all). */
  async listPendingParentInvites(studentId: string, now: Date): Promise<InvitationRow[]> {
    return this.txm.db
      .select()
      .from(invitation)
      .where(
        and(
          eq(invitation.kind, 'parent'),
          eq(invitation.status, 'pending'),
          sql`${invitation.payload}->>'studentId' = ${studentId}`,
          sql`${invitation.expiresAt} > ${now}`,
        ),
      )
      .orderBy(desc(invitation.createdAt));
  }

  async findPendingByTarget(
    kind: InvitationKind,
    telegramUserId: number,
    now: Date,
  ): Promise<InvitationRow | null> {
    const rows = await this.txm.db
      .select()
      .from(invitation)
      .where(
        and(
          eq(invitation.kind, kind),
          eq(invitation.targetTelegramUserId, telegramUserId),
          eq(invitation.status, 'pending'),
          sql`${invitation.expiresAt} > ${now}`,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Increments the use counter; the row must already be locked by the caller. */
  async markUsed(id: string, usedBy: string | null, now: Date, exhausted: boolean): Promise<void> {
    await this.txm.db
      .update(invitation)
      .set({
        usedCount: sql`${invitation.usedCount} + 1`,
        usedBy,
        usedAt: now,
        status: exhausted ? 'used' : 'pending',
      })
      .where(eq(invitation.id, id));
  }

  async revoke(id: string, revokedBy: string | null, now: Date): Promise<InvitationRow | null> {
    const rows = await this.txm.db
      .update(invitation)
      .set({ status: 'revoked', revokedBy, revokedAt: now })
      .where(and(eq(invitation.id, id), eq(invitation.status, 'pending')))
      .returning();
    return rows[0] ?? null;
  }

  /** Revokes every pending invitation issued by an account (used when its authority is withdrawn). */
  async revokeAllByCreator(createdBy: string, revokedBy: string | null, now: Date): Promise<number> {
    const rows = await this.txm.db
      .update(invitation)
      .set({ status: 'revoked', revokedBy, revokedAt: now })
      .where(and(eq(invitation.createdBy, createdBy), eq(invitation.status, 'pending')))
      .returning({ id: invitation.id });
    return rows.length;
  }

  /** UC-40: flips overdue pending invitations to `expired`, returning them for notifications. */
  async expireOverdue(now: Date, limit = 500): Promise<InvitationRow[]> {
    const overdue = this.txm.db
      .select({ id: invitation.id })
      .from(invitation)
      .where(and(eq(invitation.status, 'pending'), lte(invitation.expiresAt, now)))
      .limit(limit);
    return this.txm.db
      .update(invitation)
      .set({ status: 'expired' })
      .where(sql`${invitation.id} IN ${overdue}`)
      .returning();
  }
}
