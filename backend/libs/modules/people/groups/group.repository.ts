import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import { groupMember, type GroupMemberRow, studyGroup, type StudyGroupRow } from '../schema.js';

export interface NewGroup {
  teacherId: string;
  name: string;
  subjectId: string | null;
  emoji: string | null;
  defaultDurationMin: number | null;
}

export type GroupPatch = Partial<
  Pick<StudyGroupRow, 'name' | 'subjectId' | 'emoji' | 'defaultDurationMin' | 'archivedAt'>
>;

/** Persistence for groups (classes) and their membership history (5.4.4). */
@Injectable()
export class GroupRepository {
  constructor(private readonly txm: TransactionManager) {}

  /** Throws the raw unique violation (23505, `study_group_name_uniq`) on a duplicate active name. */
  async insert(data: NewGroup): Promise<StudyGroupRow> {
    const rows = await this.txm.db
      .insert(studyGroup)
      .values({ ...data, id: newId() })
      .returning();
    return rows[0]!;
  }

  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<StudyGroupRow | null> {
    const query = this.txm.db.select().from(studyGroup).where(eq(studyGroup.id, id)).limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async update(id: string, patch: GroupPatch): Promise<StudyGroupRow> {
    const rows = await this.txm.db.update(studyGroup).set(patch).where(eq(studyGroup.id, id)).returning();
    const row = rows[0];
    if (!row) throw new Error(`study_group ${id} not found`);
    return row;
  }

  async listByTeacher(teacherId: string, options: { archived: boolean }): Promise<StudyGroupRow[]> {
    return this.txm.db
      .select()
      .from(studyGroup)
      .where(
        and(
          eq(studyGroup.teacherId, teacherId),
          options.archived ? sql`${studyGroup.archivedAt} IS NOT NULL` : isNull(studyGroup.archivedAt),
        ),
      )
      .orderBy(sql`lower(${studyGroup.name})`, asc(studyGroup.id));
  }

  async countActiveByTeacher(teacherId: string): Promise<number> {
    return this.txm.db.$count(
      studyGroup,
      and(eq(studyGroup.teacherId, teacherId), isNull(studyGroup.archivedAt)),
    );
  }

  async listMembers(groupId: string): Promise<GroupMemberRow[]> {
    return this.txm.db
      .select()
      .from(groupMember)
      .where(and(eq(groupMember.groupId, groupId), isNull(groupMember.leftAt)))
      .orderBy(asc(groupMember.joinedAt), asc(groupMember.id));
  }

  /** Active member counts for several groups at once (list screens). */
  async countMembers(groupIds: readonly string[]): Promise<Map<string, number>> {
    if (groupIds.length === 0) return new Map();
    const rows = await this.txm.db
      .select({ groupId: groupMember.groupId, count: sql<number>`count(*)::int` })
      .from(groupMember)
      .where(and(inArray(groupMember.groupId, [...groupIds]), isNull(groupMember.leftAt)))
      .groupBy(groupMember.groupId);
    return new Map(rows.map((r) => [r.groupId, r.count]));
  }

  /** Active memberships of a student across all groups (used when a link ends, 5.8.4). */
  async listActiveMembershipsOfStudent(studentId: string): Promise<GroupMemberRow[]> {
    return this.txm.db
      .select()
      .from(groupMember)
      .where(and(eq(groupMember.studentId, studentId), isNull(groupMember.leftAt)));
  }

  /** Throws 23505 (`group_member_active_uniq`) when the student is already in the group. */
  async addMember(groupId: string, studentId: string, joinedAt: Date): Promise<GroupMemberRow> {
    const rows = await this.txm.db
      .insert(groupMember)
      .values({ id: newId(), groupId, studentId, joinedAt })
      .returning();
    return rows[0]!;
  }

  /** Closes the active membership; returns null when there is none. */
  async removeMember(groupId: string, studentId: string, leftAt: Date): Promise<GroupMemberRow | null> {
    const rows = await this.txm.db
      .update(groupMember)
      .set({ leftAt })
      .where(
        and(
          eq(groupMember.groupId, groupId),
          eq(groupMember.studentId, studentId),
          isNull(groupMember.leftAt),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /** Closes every active membership of the group in one statement (archiving); returns the closed rows. */
  async removeAllMembers(groupId: string, leftAt: Date): Promise<GroupMemberRow[]> {
    return this.txm.db
      .update(groupMember)
      .set({ leftAt })
      .where(and(eq(groupMember.groupId, groupId), isNull(groupMember.leftAt)))
      .returning();
  }

  /** Closes every active membership of the student in the teacher's groups (link ended). */
  async removeStudentFromTeacherGroups(
    teacherId: string,
    studentId: string,
    leftAt: Date,
  ): Promise<string[]> {
    const groups = this.txm.db
      .select({ id: studyGroup.id })
      .from(studyGroup)
      .where(eq(studyGroup.teacherId, teacherId));
    const rows = await this.txm.db
      .update(groupMember)
      .set({ leftAt })
      .where(
        and(
          eq(groupMember.studentId, studentId),
          isNull(groupMember.leftAt),
          inArray(groupMember.groupId, groups),
        ),
      )
      .returning({ groupId: groupMember.groupId });
    return rows.map((r) => r.groupId);
  }
}
