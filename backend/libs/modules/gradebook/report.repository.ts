import { Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import { report, type ReportRow, type ReportStatus } from './schema.js';

export interface NewReport {
  teacherId: string;
  studentId: string;
  teacherStudentId: string;
  periodFrom: string;
  periodTo: string;
  snapshot: Record<string, unknown>;
  comment: string | null;
}

/** Persistence for progress reports (5.12). No rules here. */
@Injectable()
export class ReportRepository {
  constructor(private readonly txm: TransactionManager) {}

  async insert(data: NewReport): Promise<ReportRow> {
    const rows = await this.txm.db
      .insert(report)
      .values({ ...data, id: newId() })
      .returning();
    return rows[0]!;
  }

  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<ReportRow | null> {
    const query = this.txm.db.select().from(report).where(eq(report.id, id)).limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async update(
    id: string,
    patch: Partial<Pick<ReportRow, 'snapshot' | 'comment' | 'status' | 'sentAt'>>,
  ): Promise<ReportRow> {
    const rows = await this.txm.db.update(report).set(patch).where(eq(report.id, id)).returning();
    const row = rows[0];
    if (!row) throw new Error(`report ${id} not found`);
    return row;
  }

  /** Reports of a teacher about a student, newest first; drafts included unless a status is given. */
  async listByPair(
    teacherId: string,
    studentId: string,
    status?: ReportStatus,
    limit = 20,
  ): Promise<ReportRow[]> {
    return this.txm.db
      .select()
      .from(report)
      .where(
        and(
          eq(report.teacherId, teacherId),
          eq(report.studentId, studentId),
          status ? eq(report.status, status) : undefined,
        ),
      )
      .orderBy(desc(report.createdAt), desc(report.id))
      .limit(limit);
  }

  /** Sent reports a student (or their parent) may read, newest first. */
  async listSentForStudent(studentId: string, limit = 20): Promise<ReportRow[]> {
    return this.txm.db
      .select()
      .from(report)
      .where(and(eq(report.studentId, studentId), eq(report.status, 'sent')))
      .orderBy(desc(report.sentAt), desc(report.id))
      .limit(limit);
  }
}
