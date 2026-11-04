import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import {
  assignment,
  assignmentGroup,
  type AssignmentInsert,
  type AssignmentRow,
  type AssignmentStatus,
  assignmentTarget,
  type AssignmentTargetInsert,
  type AssignmentTargetRow,
  type TargetStatus,
} from './schema.js';

export type NewAssignment = Omit<AssignmentInsert, 'id' | 'createdAt' | 'updatedAt'>;
export type AssignmentPatch = Partial<Omit<AssignmentInsert, 'id' | 'teacherId' | 'createdAt' | 'updatedAt'>>;
/** `createdAt` comes from the application clock (period statistics, tests). */
export type NewTarget = Omit<AssignmentTargetInsert, 'id' | 'updatedAt'>;
export type TargetPatch = Partial<
  Pick<AssignmentTargetRow, 'dueAt' | 'dueLessonId' | 'status' | 'viewedAt' | 'overdueNotifiedAt'>
>;
/** Statuses that are not finished yet (5.10.2). */
export const OPEN_TARGET_STATUSES: readonly TargetStatus[] = ['assigned', 'overdue', 'returned', 'submitted'];

/** Persistence for assignments, their group addressees and per-student targets (5.10). No rules here. */
@Injectable()
export class AssignmentRepository {
  constructor(private readonly txm: TransactionManager) {}

  async insert(data: NewAssignment): Promise<AssignmentRow> {
    const rows = await this.txm.db
      .insert(assignment)
      .values({ ...data, id: newId() })
      .returning();
    return rows[0]!;
  }

  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<AssignmentRow | null> {
    const query = this.txm.db.select().from(assignment).where(eq(assignment.id, id)).limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async findByIds(ids: readonly string[]): Promise<AssignmentRow[]> {
    if (ids.length === 0) return [];
    return this.txm.db
      .select()
      .from(assignment)
      .where(inArray(assignment.id, [...ids]));
  }

  async update(id: string, patch: AssignmentPatch): Promise<AssignmentRow> {
    const rows = await this.txm.db.update(assignment).set(patch).where(eq(assignment.id, id)).returning();
    const row = rows[0];
    if (!row) throw new Error(`assignment ${id} not found`);
    return row;
  }

  async listByTeacher(teacherId: string, statuses?: readonly AssignmentStatus[]): Promise<AssignmentRow[]> {
    return this.txm.db
      .select()
      .from(assignment)
      .where(
        and(
          eq(assignment.teacherId, teacherId),
          statuses ? inArray(assignment.status, [...statuses]) : undefined,
        ),
      )
      .orderBy(desc(assignment.createdAt), desc(assignment.id));
  }

  // --- groups -------------------------------------------------------------------------------------

  async addGroup(assignmentId: string, groupId: string): Promise<void> {
    await this.txm.db
      .insert(assignmentGroup)
      .values({ id: newId(), assignmentId, groupId })
      .onConflictDoNothing();
  }

  async listGroupIds(assignmentId: string): Promise<string[]> {
    const rows = await this.txm.db
      .select({ groupId: assignmentGroup.groupId })
      .from(assignmentGroup)
      .where(eq(assignmentGroup.assignmentId, assignmentId));
    return rows.map((r) => r.groupId);
  }

  /** Published assignments addressed to a group (a new member becomes a target). */
  async listPublishedByGroup(groupId: string): Promise<AssignmentRow[]> {
    const ids = this.txm.db
      .select({ id: assignmentGroup.assignmentId })
      .from(assignmentGroup)
      .where(eq(assignmentGroup.groupId, groupId));
    return this.txm.db
      .select()
      .from(assignment)
      .where(and(inArray(assignment.id, ids), eq(assignment.status, 'published')));
  }

  // --- targets ------------------------------------------------------------------------------------

  async insertTarget(data: NewTarget): Promise<AssignmentTargetRow | null> {
    const rows = await this.txm.db
      .insert(assignmentTarget)
      .values({ ...data, id: newId() })
      .onConflictDoNothing()
      .returning();
    return rows[0] ?? null;
  }

  async findTarget(id: string, options: { forUpdate?: boolean } = {}): Promise<AssignmentTargetRow | null> {
    const query = this.txm.db.select().from(assignmentTarget).where(eq(assignmentTarget.id, id)).limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async findTargetOf(
    assignmentId: string,
    studentId: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<AssignmentTargetRow | null> {
    const query = this.txm.db
      .select()
      .from(assignmentTarget)
      .where(and(eq(assignmentTarget.assignmentId, assignmentId), eq(assignmentTarget.studentId, studentId)))
      .limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async updateTarget(id: string, patch: TargetPatch): Promise<AssignmentTargetRow> {
    const rows = await this.txm.db
      .update(assignmentTarget)
      .set(patch)
      .where(eq(assignmentTarget.id, id))
      .returning();
    const row = rows[0];
    if (!row) throw new Error(`assignment_target ${id} not found`);
    return row;
  }

  /** Guarded transition: applies only while the row is still in one of `fromStatuses`; null otherwise. */
  async transitionTarget(
    id: string,
    fromStatuses: readonly TargetStatus[],
    patch: TargetPatch,
  ): Promise<AssignmentTargetRow | null> {
    const rows = await this.txm.db
      .update(assignmentTarget)
      .set(patch)
      .where(and(eq(assignmentTarget.id, id), inArray(assignmentTarget.status, [...fromStatuses])))
      .returning();
    return rows[0] ?? null;
  }

  async deleteTarget(id: string): Promise<void> {
    await this.txm.db.delete(assignmentTarget).where(eq(assignmentTarget.id, id));
  }

  async listTargets(assignmentId: string): Promise<AssignmentTargetRow[]> {
    return this.txm.db
      .select()
      .from(assignmentTarget)
      .where(eq(assignmentTarget.assignmentId, assignmentId))
      .orderBy(asc(assignmentTarget.createdAt));
  }

  async listTargetsOf(assignmentIds: readonly string[]): Promise<AssignmentTargetRow[]> {
    if (assignmentIds.length === 0) return [];
    return this.txm.db
      .select()
      .from(assignmentTarget)
      .where(inArray(assignmentTarget.assignmentId, [...assignmentIds]));
  }

  /** A student's targets across teachers (optionally one teacher), by status, nearest due date first. */
  async listTargetsByStudent(
    studentId: string,
    statuses: readonly TargetStatus[],
    teacherId?: string,
  ): Promise<AssignmentTargetRow[]> {
    const ofTeacher = teacherId
      ? this.txm.db.select({ id: assignment.id }).from(assignment).where(eq(assignment.teacherId, teacherId))
      : null;
    return this.txm.db
      .select()
      .from(assignmentTarget)
      .where(
        and(
          eq(assignmentTarget.studentId, studentId),
          inArray(assignmentTarget.status, [...statuses]),
          ofTeacher ? inArray(assignmentTarget.assignmentId, ofTeacher) : undefined,
        ),
      )
      .orderBy(sql`${assignmentTarget.dueAt} NULLS LAST`, asc(assignmentTarget.createdAt));
  }

  /** Targets whose due date passed without a submission (UC-40), locked and limited for the sweep. */
  async lockOverdue(now: Date, limit: number): Promise<AssignmentTargetRow[]> {
    return this.txm.db
      .select()
      .from(assignmentTarget)
      .where(
        and(
          eq(assignmentTarget.status, 'assigned'),
          isNotNull(assignmentTarget.dueAt),
          lt(assignmentTarget.dueAt, now),
        ),
      )
      .orderBy(asc(assignmentTarget.dueAt))
      .limit(limit)
      .for('update', { skipLocked: true });
  }

  /** Open targets that follow a lesson's start time (next-lesson mode). */
  async listTargetsByDueLesson(lessonId: string): Promise<AssignmentTargetRow[]> {
    return this.txm.db
      .select()
      .from(assignmentTarget)
      .where(
        and(
          eq(assignmentTarget.dueLessonId, lessonId),
          inArray(assignmentTarget.status, ['assigned', 'overdue', 'returned']),
        ),
      );
  }

  /** Open targets of a teacher's student (withdrawn when the link ends). */
  async listOpenTargetsOfPair(teacherId: string, studentId: string): Promise<AssignmentTargetRow[]> {
    const ofTeacher = this.txm.db
      .select({ id: assignment.id })
      .from(assignment)
      .where(eq(assignment.teacherId, teacherId));
    return this.txm.db
      .select()
      .from(assignmentTarget)
      .where(
        and(
          eq(assignmentTarget.studentId, studentId),
          inArray(assignmentTarget.assignmentId, ofTeacher),
          inArray(assignmentTarget.status, [...OPEN_TARGET_STATUSES]),
        ),
      );
  }

  async countByStatus(assignmentIds: readonly string[]): Promise<Map<string, Record<TargetStatus, number>>> {
    const out = new Map<string, Record<TargetStatus, number>>();
    for (const t of await this.listTargetsOf(assignmentIds)) {
      const counts = out.get(t.assignmentId) ?? {
        assigned: 0,
        submitted: 0,
        overdue: 0,
        returned: 0,
        accepted: 0,
        withdrawn: 0,
      };
      counts[t.status] += 1;
      out.set(t.assignmentId, counts);
    }
    return out;
  }
}
