import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import { familyLink, type FamilyLinkRow } from '../schema.js';

export interface NewFamilyLink {
  parentId: string;
  studentId: string;
  invitedBy: string | null;
  invitationId: string | null;
  confirmedAt: Date;
}

/** Persistence for family links (parent–child). */
@Injectable()
export class FamilyLinkRepository {
  constructor(private readonly txm: TransactionManager) {}

  async insert(data: NewFamilyLink): Promise<FamilyLinkRow> {
    const rows = await this.txm.db
      .insert(familyLink)
      .values({ ...data, id: newId(), status: 'active' })
      .returning();
    return rows[0]!;
  }

  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<FamilyLinkRow | null> {
    const query = this.txm.db.select().from(familyLink).where(eq(familyLink.id, id)).limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async findActive(parentId: string, studentId: string): Promise<FamilyLinkRow | null> {
    const rows = await this.txm.db
      .select()
      .from(familyLink)
      .where(
        and(
          eq(familyLink.parentId, parentId),
          eq(familyLink.studentId, studentId),
          eq(familyLink.status, 'active'),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async listActiveByStudent(studentId: string): Promise<FamilyLinkRow[]> {
    return this.txm.db
      .select()
      .from(familyLink)
      .where(and(eq(familyLink.studentId, studentId), eq(familyLink.status, 'active')))
      .orderBy(asc(familyLink.confirmedAt), asc(familyLink.id));
  }

  async listActiveByParent(parentId: string): Promise<FamilyLinkRow[]> {
    return this.txm.db
      .select()
      .from(familyLink)
      .where(and(eq(familyLink.parentId, parentId), eq(familyLink.status, 'active')))
      .orderBy(asc(familyLink.confirmedAt), asc(familyLink.id));
  }

  async revoke(id: string, revokedBy: string | null, now: Date): Promise<FamilyLinkRow | null> {
    const rows = await this.txm.db
      .update(familyLink)
      .set({ status: 'revoked', revokedAt: now, revokedBy })
      .where(and(eq(familyLink.id, id), eq(familyLink.status, 'active')))
      .returning();
    return rows[0] ?? null;
  }
}
