import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import {
  accessGrant,
  type AccessGrantInsert,
  type AccessGrantRow,
  type GrantSubjectType,
  materialView,
  type MaterialViewRow,
} from './schema.js';

export type NewGrant = Omit<AccessGrantInsert, 'id' | 'createdAt' | 'revokedAt'>;

/** Persistence for access grants (5.9.3) and «просмотрено» marks (5.9.4). No rules here. */
@Injectable()
export class GrantRepository {
  constructor(private readonly txm: TransactionManager) {}

  async insert(data: NewGrant): Promise<AccessGrantRow> {
    const rows = await this.txm.db
      .insert(accessGrant)
      .values({ ...data, id: newId() })
      .returning();
    return rows[0]!;
  }

  /** Lesson-sourced grant; null when the lesson already handed this subject to the student (unique index). */
  async insertFromLesson(data: NewGrant): Promise<AccessGrantRow | null> {
    const rows = await this.txm.db
      .insert(accessGrant)
      .values({ ...data, id: newId() })
      .onConflictDoNothing()
      .returning();
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<AccessGrantRow | null> {
    const rows = await this.txm.db.select().from(accessGrant).where(eq(accessGrant.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async revoke(id: string, at: Date): Promise<AccessGrantRow | null> {
    const rows = await this.txm.db
      .update(accessGrant)
      .set({ revokedAt: at })
      .where(and(eq(accessGrant.id, id), isNull(accessGrant.revokedAt)))
      .returning();
    return rows[0] ?? null;
  }

  /** Live grants of one subject (a material, a collection, an assignment), oldest first. */
  async listBySubject(subjectType: GrantSubjectType, subjectId: string): Promise<AccessGrantRow[]> {
    return this.txm.db
      .select()
      .from(accessGrant)
      .where(
        and(
          eq(accessGrant.subjectType, subjectType),
          eq(accessGrant.subjectId, subjectId),
          isNull(accessGrant.revokedAt),
        ),
      )
      .orderBy(asc(accessGrant.createdAt));
  }

  /** Live grants that reach a student directly or through any of the given groups. */
  async listForStudent(
    studentId: string,
    groupIds: readonly string[],
    teacherId?: string,
  ): Promise<AccessGrantRow[]> {
    const reach = [
      and(eq(accessGrant.granteeType, 'student'), eq(accessGrant.granteeId, studentId)),
      groupIds.length > 0
        ? and(eq(accessGrant.granteeType, 'group'), inArray(accessGrant.granteeId, [...groupIds]))
        : undefined,
    ].filter(Boolean);
    return this.txm.db
      .select()
      .from(accessGrant)
      .where(
        and(
          isNull(accessGrant.revokedAt),
          teacherId ? eq(accessGrant.teacherId, teacherId) : undefined,
          sql`(${sql.join(
            reach.map((c) => sql`(${c})`),
            sql` OR `,
          )})`,
        ),
      )
      .orderBy(asc(accessGrant.createdAt));
  }

  /** Live grants a lesson handed to one student (revoked when the student leaves the lesson). */
  async listBySourceLesson(lessonId: string, studentId: string): Promise<AccessGrantRow[]> {
    return this.txm.db
      .select()
      .from(accessGrant)
      .where(
        and(
          eq(accessGrant.sourceLessonId, lessonId),
          eq(accessGrant.granteeType, 'student'),
          eq(accessGrant.granteeId, studentId),
          isNull(accessGrant.revokedAt),
        ),
      );
  }

  /** Live grants addressed to a group (a new member learns about them). */
  async listByGroup(groupId: string): Promise<AccessGrantRow[]> {
    return this.txm.db
      .select()
      .from(accessGrant)
      .where(
        and(
          eq(accessGrant.granteeType, 'group'),
          eq(accessGrant.granteeId, groupId),
          isNull(accessGrant.revokedAt),
        ),
      )
      .orderBy(asc(accessGrant.createdAt));
  }

  // --- views ------------------------------------------------------------------------------------

  async markViewed(materialId: string, studentId: string, at: Date): Promise<void> {
    await this.txm.db
      .insert(materialView)
      .values({ id: newId(), materialId, studentId, firstViewedAt: at, lastViewedAt: at })
      .onConflictDoUpdate({
        target: [materialView.materialId, materialView.studentId],
        set: { lastViewedAt: at },
      });
  }

  async listViews(materialId: string): Promise<MaterialViewRow[]> {
    return this.txm.db.select().from(materialView).where(eq(materialView.materialId, materialId));
  }

  async viewedBy(studentId: string, materialIds: readonly string[]): Promise<Set<string>> {
    if (materialIds.length === 0) return new Set();
    const rows = await this.txm.db
      .select({ materialId: materialView.materialId })
      .from(materialView)
      .where(and(eq(materialView.studentId, studentId), inArray(materialView.materialId, [...materialIds])));
    return new Set(rows.map((r) => r.materialId));
  }
}
