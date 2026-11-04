import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import { leaveRequest, type LeaveRequestRow, type LeaveStatus } from '../schema.js';

export interface NewLeaveRequest {
  teacherStudentId: string;
  initiatedBy: string;
  reason: string;
  expiresAt: Date;
}

/** Persistence for leave requests (5.8.2): one pending request per link. */
@Injectable()
export class LeaveRequestRepository {
  constructor(private readonly txm: TransactionManager) {}

  /** Throws 23505 (`leave_request_single_pending`) when a pending request already exists for the link. */
  async insert(data: NewLeaveRequest): Promise<LeaveRequestRow> {
    const rows = await this.txm.db
      .insert(leaveRequest)
      .values({ ...data, id: newId() })
      .returning();
    return rows[0]!;
  }

  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<LeaveRequestRow | null> {
    const query = this.txm.db.select().from(leaveRequest).where(eq(leaveRequest.id, id)).limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async findPendingByLink(teacherStudentId: string): Promise<LeaveRequestRow | null> {
    const rows = await this.txm.db
      .select()
      .from(leaveRequest)
      .where(and(eq(leaveRequest.teacherStudentId, teacherStudentId), eq(leaveRequest.status, 'pending')))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Pending requests of several links (a parent's children), oldest first. */
  async listPendingByLinks(linkIds: readonly string[]): Promise<LeaveRequestRow[]> {
    if (linkIds.length === 0) return [];
    return this.txm.db
      .select()
      .from(leaveRequest)
      .where(and(inArray(leaveRequest.teacherStudentId, [...linkIds]), eq(leaveRequest.status, 'pending')))
      .orderBy(asc(leaveRequest.createdAt));
  }

  /** Transitions a pending request; returns null when it is no longer pending (decided or expired meanwhile). */
  async decide(
    id: string,
    status: Exclude<LeaveStatus, 'pending'>,
    patch: { decidedBy: string | null; decisionComment: string | null; decidedAt: Date },
  ): Promise<LeaveRequestRow | null> {
    const rows = await this.txm.db
      .update(leaveRequest)
      .set({ status, ...patch })
      .where(and(eq(leaveRequest.id, id), eq(leaveRequest.status, 'pending')))
      .returning();
    return rows[0] ?? null;
  }

  /** Pending requests past their deadline, locked for the expiry job (UC-40). */
  async lockOverdue(now: Date, limit = 200): Promise<LeaveRequestRow[]> {
    return this.txm.db
      .select()
      .from(leaveRequest)
      .where(and(eq(leaveRequest.status, 'pending'), lte(leaveRequest.expiresAt, now)))
      .orderBy(asc(leaveRequest.expiresAt))
      .limit(limit)
      .for('update', { skipLocked: true });
  }
}
