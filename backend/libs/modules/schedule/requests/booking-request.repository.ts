import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import { bookingRequest, type BookingRequestRow, type RequestKind, type RequestStatus } from '../schema.js';

export interface NewBookingRequest {
  teacherId: string;
  studentId: string;
  kind: RequestKind;
  lessonId: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  comment: string | null;
  createdBy: string;
}

export interface Decision {
  status: Exclude<RequestStatus, 'pending'>;
  decidedBy: string | null;
  decisionMessage?: string | null;
  decisionReason: string;
  decidedAt: Date;
}

/** Persistence of booking and reschedule requests (5.5.5, 5.7.4). No business rules here. */
@Injectable()
export class BookingRequestRepository {
  constructor(private readonly txm: TransactionManager) {}

  async insert(data: NewBookingRequest): Promise<BookingRequestRow> {
    const rows = await this.txm.db
      .insert(bookingRequest)
      .values({ ...data, id: newId() })
      .returning();
    return rows[0]!;
  }

  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<BookingRequestRow | null> {
    const query = this.txm.db.select().from(bookingRequest).where(eq(bookingRequest.id, id)).limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async decide(id: string, decision: Decision): Promise<BookingRequestRow | null> {
    const rows = await this.txm.db
      .update(bookingRequest)
      .set({
        status: decision.status,
        decidedBy: decision.decidedBy,
        decisionMessage: decision.decisionMessage ?? null,
        decisionReason: decision.decisionReason,
        decidedAt: decision.decidedAt,
      })
      .where(and(eq(bookingRequest.id, id), eq(bookingRequest.status, 'pending')))
      .returning();
    return rows[0] ?? null;
  }

  async listPendingByTeacher(teacherId: string): Promise<BookingRequestRow[]> {
    return this.txm.db
      .select()
      .from(bookingRequest)
      .where(and(eq(bookingRequest.teacherId, teacherId), eq(bookingRequest.status, 'pending')))
      .orderBy(asc(bookingRequest.createdAt), asc(bookingRequest.id));
  }

  async listPendingByStudent(studentId: string): Promise<BookingRequestRow[]> {
    return this.txm.db
      .select()
      .from(bookingRequest)
      .where(and(eq(bookingRequest.studentId, studentId), eq(bookingRequest.status, 'pending')))
      .orderBy(asc(bookingRequest.createdAt), asc(bookingRequest.id));
  }

  /** Pending requests about a lesson, locked (the lesson is being moved or cancelled). */
  async lockPendingByLesson(lessonId: string): Promise<BookingRequestRow[]> {
    return this.txm.db
      .select()
      .from(bookingRequest)
      .where(and(eq(bookingRequest.lessonId, lessonId), eq(bookingRequest.status, 'pending')))
      .orderBy(asc(bookingRequest.id))
      .for('update');
  }

  /** Pending requests of a teacher overlapping `[start, end)`, locked (accepting one declines the rest, 5.5.5). */
  async lockPendingOverlapping(
    teacherId: string,
    start: Date,
    end: Date,
    kind?: RequestKind,
  ): Promise<BookingRequestRow[]> {
    return this.txm.db
      .select()
      .from(bookingRequest)
      .where(
        and(
          eq(bookingRequest.teacherId, teacherId),
          eq(bookingRequest.status, 'pending'),
          kind ? eq(bookingRequest.kind, kind) : undefined,
          isNotNull(bookingRequest.startsAt),
          lt(bookingRequest.startsAt, end),
          sql`${bookingRequest.endsAt} > ${start}`,
        ),
      )
      .orderBy(asc(bookingRequest.id))
      .for('update');
  }

  /**
   * Pending timed requests whose slot starts before `before` (expiry sweep), locked for this run; `after` pages
   * past rows already examined (keyset on start and id), so rows that are still valid cannot stall the sweep.
   */
  async lockPendingStartingBefore(
    before: Date,
    limit: number,
    after?: { startsAt: Date; id: string },
  ): Promise<BookingRequestRow[]> {
    return this.txm.db
      .select()
      .from(bookingRequest)
      .where(
        and(
          eq(bookingRequest.status, 'pending'),
          isNotNull(bookingRequest.startsAt),
          lt(bookingRequest.startsAt, before),
          after
            ? sql`(${bookingRequest.startsAt}, ${bookingRequest.id}) > (${after.startsAt}, ${after.id})`
            : undefined,
        ),
      )
      .orderBy(asc(bookingRequest.startsAt), asc(bookingRequest.id))
      .limit(limit)
      .for('update', { skipLocked: true });
  }

  /** Pending booking requests of a teacher inside a range, unlocked (open slots hide the full ones, 5.5.5). */
  async listPendingBookingsIn(
    teacherId: string,
    range: { start: Date; end: Date },
  ): Promise<BookingRequestRow[]> {
    return this.txm.db
      .select()
      .from(bookingRequest)
      .where(
        and(
          eq(bookingRequest.teacherId, teacherId),
          eq(bookingRequest.status, 'pending'),
          eq(bookingRequest.kind, 'booking'),
          isNotNull(bookingRequest.startsAt),
          lt(bookingRequest.startsAt, range.end),
          sql`${bookingRequest.endsAt} > ${range.start}`,
        ),
      )
      .orderBy(asc(bookingRequest.startsAt), asc(bookingRequest.id));
  }

  /** How many pending booking requests overlap the slot (5.5.5 «не больше N»). */
  async countPendingOverlapping(teacherId: string, start: Date, end: Date): Promise<number> {
    const rows = await this.txm.db
      .select({ n: sql<number>`count(*)::int` })
      .from(bookingRequest)
      .where(
        and(
          eq(bookingRequest.teacherId, teacherId),
          eq(bookingRequest.status, 'pending'),
          isNotNull(bookingRequest.startsAt),
          lt(bookingRequest.startsAt, end),
          sql`${bookingRequest.endsAt} > ${start}`,
        ),
      );
    return rows[0]?.n ?? 0;
  }
}
