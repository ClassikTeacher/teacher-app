import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import {
  assignmentTarget,
  submission,
  submissionFile,
  type SubmissionFileRow,
  type SubmissionInsert,
  submissionReview,
  submissionReviewFile,
  type SubmissionReviewFileRow,
  type SubmissionReviewRow,
  type SubmissionRow,
} from './schema.js';

export type NewSubmission = Omit<SubmissionInsert, 'id'>;
export type NewReview = Omit<SubmissionReviewRow, 'id'>;

/** Persistence for submissions, their files and the teacher's review (5.10.3, 5.10.4). No rules here. */
@Injectable()
export class SubmissionRepository {
  constructor(private readonly txm: TransactionManager) {}

  async insert(data: NewSubmission, fileIds: readonly string[]): Promise<SubmissionRow> {
    const rows = await this.txm.db
      .insert(submission)
      .values({ ...data, id: newId() })
      .returning();
    const row = rows[0]!;
    if (fileIds.length > 0)
      await this.txm.db
        .insert(submissionFile)
        .values(fileIds.map((fileId, position) => ({ id: newId(), submissionId: row.id, fileId, position })));
    return row;
  }

  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<SubmissionRow | null> {
    const query = this.txm.db.select().from(submission).where(eq(submission.id, id)).limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async listByTarget(targetId: string): Promise<SubmissionRow[]> {
    return this.txm.db
      .select()
      .from(submission)
      .where(eq(submission.targetId, targetId))
      .orderBy(desc(submission.attemptNo));
  }

  async listByTargets(targetIds: readonly string[]): Promise<SubmissionRow[]> {
    if (targetIds.length === 0) return [];
    return this.txm.db
      .select()
      .from(submission)
      .where(inArray(submission.targetId, [...targetIds]))
      .orderBy(asc(submission.submittedAt));
  }

  /**
   * The teacher's queue «На проверке»: the latest attempt of every target still `submitted`, oldest first
   * (5.10.4). Withdrawn or closed work drops out of the queue and the digest.
   */
  async listUnreviewed(teacherId: string, limit = 50): Promise<SubmissionRow[]> {
    const rows = await this.txm.db
      .select({ submission })
      .from(submission)
      .innerJoin(assignmentTarget, eq(assignmentTarget.id, submission.targetId))
      .leftJoin(submissionReview, eq(submissionReview.submissionId, submission.id))
      .where(
        and(
          eq(submission.teacherId, teacherId),
          eq(assignmentTarget.status, 'submitted'),
          isNull(submissionReview.id),
        ),
      )
      .orderBy(asc(submission.submittedAt))
      .limit(limit);
    return rows.map((r) => r.submission);
  }

  async countUnreviewed(teacherId: string): Promise<number> {
    const rows = await this.txm.db
      .select({ n: sql<number>`count(*)::int` })
      .from(submission)
      .innerJoin(assignmentTarget, eq(assignmentTarget.id, submission.targetId))
      .leftJoin(submissionReview, eq(submissionReview.submissionId, submission.id))
      .where(
        and(
          eq(submission.teacherId, teacherId),
          eq(assignmentTarget.status, 'submitted'),
          isNull(submissionReview.id),
        ),
      );
    return rows[0]?.n ?? 0;
  }

  async listFilesOf(submissionIds: readonly string[]): Promise<SubmissionFileRow[]> {
    if (submissionIds.length === 0) return [];
    return this.txm.db
      .select()
      .from(submissionFile)
      .where(inArray(submissionFile.submissionId, [...submissionIds]))
      .orderBy(asc(submissionFile.position));
  }

  async listReviewFilesOf(reviewIds: readonly string[]): Promise<SubmissionReviewFileRow[]> {
    if (reviewIds.length === 0) return [];
    return this.txm.db
      .select()
      .from(submissionReviewFile)
      .where(inArray(submissionReviewFile.reviewId, [...reviewIds]))
      .orderBy(asc(submissionReviewFile.position));
  }

  async listFiles(submissionId: string): Promise<SubmissionFileRow[]> {
    return this.txm.db
      .select()
      .from(submissionFile)
      .where(eq(submissionFile.submissionId, submissionId))
      .orderBy(asc(submissionFile.position));
  }

  async insertReview(data: NewReview, fileIds: readonly string[]): Promise<SubmissionReviewRow> {
    const rows = await this.txm.db
      .insert(submissionReview)
      .values({ ...data, id: newId() })
      .returning();
    const row = rows[0]!;
    if (fileIds.length > 0)
      await this.txm.db
        .insert(submissionReviewFile)
        .values(fileIds.map((fileId, position) => ({ id: newId(), reviewId: row.id, fileId, position })));
    return row;
  }

  async findReview(submissionId: string): Promise<SubmissionReviewRow | null> {
    const rows = await this.txm.db
      .select()
      .from(submissionReview)
      .where(eq(submissionReview.submissionId, submissionId))
      .limit(1);
    return rows[0] ?? null;
  }

  async listReviews(submissionIds: readonly string[]): Promise<SubmissionReviewRow[]> {
    if (submissionIds.length === 0) return [];
    return this.txm.db
      .select()
      .from(submissionReview)
      .where(inArray(submissionReview.submissionId, [...submissionIds]));
  }

  async listReviewFiles(reviewId: string): Promise<SubmissionReviewFileRow[]> {
    return this.txm.db
      .select()
      .from(submissionReviewFile)
      .where(eq(submissionReviewFile.reviewId, reviewId))
      .orderBy(asc(submissionReviewFile.position));
  }
}
