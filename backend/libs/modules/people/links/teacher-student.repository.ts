import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import {
  type EndReason,
  type LinkStatus,
  teacherStudent,
  type TeacherStudentInsert,
  teacherStudentPeriod,
  type TeacherStudentPeriodRow,
  type TeacherStudentRow,
} from '../schema.js';

export interface NewPendingLink {
  teacherId: string;
  invitationId: string;
  inviteName: string | null;
  inviteGrade: string | null;
  subjectIds: string[];
  maxLessonsPerWeek: number | null;
}

export interface NewActiveLink {
  teacherId: string;
  studentId: string;
  subjectIds: string[];
  maxLessonsPerWeek: number | null;
  startedAt: Date;
}

export type LinkPatch = Partial<Omit<TeacherStudentInsert, 'id' | 'teacherId' | 'createdAt' | 'updatedAt'>>;

/** Persistence for teacher–student links and their activity periods. No business rules here. */
@Injectable()
export class TeacherStudentRepository {
  constructor(private readonly txm: TransactionManager) {}

  async insertPending(data: NewPendingLink): Promise<TeacherStudentRow> {
    const rows = await this.txm.db
      .insert(teacherStudent)
      .values({ ...data, id: newId(), status: 'pending' })
      .returning();
    return rows[0]!;
  }

  /** An already accepted link (fixtures, future imports); the caller opens the period. */
  async insertActive(data: NewActiveLink): Promise<TeacherStudentRow> {
    const rows = await this.txm.db
      .insert(teacherStudent)
      .values({ ...data, id: newId(), status: 'active' })
      .returning();
    return rows[0]!;
  }

  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<TeacherStudentRow | null> {
    const query = this.txm.db.select().from(teacherStudent).where(eq(teacherStudent.id, id)).limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async findByPair(
    teacherId: string,
    studentId: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<TeacherStudentRow | null> {
    const query = this.txm.db
      .select()
      .from(teacherStudent)
      .where(and(eq(teacherStudent.teacherId, teacherId), eq(teacherStudent.studentId, studentId)))
      .limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async findByInvitationId(
    invitationId: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<TeacherStudentRow | null> {
    const query = this.txm.db
      .select()
      .from(teacherStudent)
      .where(eq(teacherStudent.invitationId, invitationId))
      .limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async update(id: string, patch: LinkPatch): Promise<TeacherStudentRow> {
    if (Object.keys(patch).length === 0) {
      const current = await this.findById(id);
      if (!current) throw new Error(`teacher_student ${id} not found`);
      return current;
    }
    const rows = await this.txm.db
      .update(teacherStudent)
      .set(patch)
      .where(eq(teacherStudent.id, id))
      .returning();
    const row = rows[0];
    if (!row) throw new Error(`teacher_student ${id} not found`);
    return row;
  }

  /** Cards of a teacher in the given statuses; newest activity first. */
  async listByTeacher(teacherId: string, statuses: readonly LinkStatus[]): Promise<TeacherStudentRow[]> {
    if (statuses.length === 0) return [];
    return this.txm.db
      .select()
      .from(teacherStudent)
      .where(and(eq(teacherStudent.teacherId, teacherId), inArray(teacherStudent.status, [...statuses])))
      .orderBy(desc(teacherStudent.updatedAt), asc(teacherStudent.id));
  }

  async listByStudent(studentId: string, statuses: readonly LinkStatus[]): Promise<TeacherStudentRow[]> {
    if (statuses.length === 0) return [];
    return this.txm.db
      .select()
      .from(teacherStudent)
      .where(and(eq(teacherStudent.studentId, studentId), inArray(teacherStudent.status, [...statuses])))
      .orderBy(desc(teacherStudent.updatedAt), asc(teacherStudent.id));
  }

  /** PPL-05: active and pending cards both count against `max_students`. */
  async countByTeacher(teacherId: string, statuses: readonly LinkStatus[]): Promise<number> {
    if (statuses.length === 0) return 0;
    return this.txm.db.$count(
      teacherStudent,
      and(eq(teacherStudent.teacherId, teacherId), inArray(teacherStudent.status, [...statuses])),
    );
  }

  /**
   * Serialises seat accounting of one teacher (transaction-scoped advisory lock), so two concurrent
   * invitations cannot both pass `max_students` — even when the teacher has no cards to row-lock yet.
   */
  async lockTeacherSeats(teacherId: string): Promise<void> {
    await this.txm.db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`student-limit:${teacherId}`}))`);
  }

  /**
   * Serialises acceptance for one teacher–student pair (transaction-scoped advisory lock): two invitations
   * of the same teacher accepted at once by the same person must end as one CONFLICT, not a 23505.
   */
  async lockPair(teacherId: string, studentId: string): Promise<void> {
    await this.txm.db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${teacherId}:${studentId}`}))`);
  }

  async openPeriod(linkId: string, startedAt: Date): Promise<TeacherStudentPeriodRow> {
    const rows = await this.txm.db
      .insert(teacherStudentPeriod)
      .values({ id: newId(), linkId, startedAt })
      .returning();
    return rows[0]!;
  }

  async closePeriod(linkId: string, endedAt: Date, endReason: EndReason): Promise<void> {
    await this.txm.db
      .update(teacherStudentPeriod)
      .set({ endedAt, endReason })
      .where(and(eq(teacherStudentPeriod.linkId, linkId), isNull(teacherStudentPeriod.endedAt)));
  }

  async listPeriods(linkId: string): Promise<TeacherStudentPeriodRow[]> {
    return this.txm.db
      .select()
      .from(teacherStudentPeriod)
      .where(eq(teacherStudentPeriod.linkId, linkId))
      .orderBy(asc(teacherStudentPeriod.startedAt));
  }
}
