import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { type Actor, assertRole } from '@modules/access/actor.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { FileMaintenanceJob } from '@modules/files/file-maintenance.job.js';
import { FileRepository } from '@modules/files/file.repository.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { AssignmentRepository } from './assignment.repository.js';
import { MAX_REVIEW_COMMENT_LENGTH } from './homework.rules.js';
import type { ReviewDecision, SubmissionReviewRow, SubmissionRow } from './schema.js';
import { SubmissionRepository } from './submission.repository.js';

export interface ReviewInput {
  submissionId: string;
  decision: ReviewDecision;
  comment?: string | null;
  /** «Прикрепить проверенный файл»: draft files stored by the teacher. */
  fileIds?: readonly string[];
}

/**
 * UC-28 (5.10.4): «Принять» or «На доработку» (comment required), optional comment and checked files; the
 * student (and parents by the copy rule) get `submission.reviewed`. A grade («Оценить») goes through the
 * gradebook port of M6-01 and fills `grade_entry_id`.
 */
@Injectable()
export class ReviewUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly assignments: AssignmentRepository,
    private readonly submissions: SubmissionRepository,
    private readonly files: FileRepository,
    private readonly fileStore: FileMaintenanceJob,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  /** The teacher's own submission (8.0), or NOT_FOUND. */
  async own(actor: Actor, submissionId: string, forUpdate = false): Promise<SubmissionRow> {
    assertRole(actor, 'TEACHER');
    const row = await this.submissions.findById(submissionId, { forUpdate });
    if (!row || row.teacherId !== actor.accountId) throw AppError.notFound('submission', submissionId);
    return row;
  }

  /**
   * Р-27: a reviewed submission's files (the student's and the teacher's) are removed from storage to free the
   * quota; the texts, the verdict and the history stay. Refused while the work is still unchecked.
   */
  async purgeFiles(actor: Actor, submissionId: string): Promise<number> {
    const submission = await this.own(actor, submissionId);
    const review = await this.submissions.findReview(submission.id);
    if (!review)
      throw new AppError('CONFLICT', 'Review the work before removing its files', { reason: 'unreviewed' });
    const ids = [
      ...(await this.submissions.listFiles(submission.id)).map((f) => f.fileId),
      ...(await this.submissions.listReviewFiles(review.id)).map((f) => f.fileId),
    ];
    let removed = 0;
    for (const id of ids) if (await this.fileStore.remove(id)) removed += 1;
    await this.audit.record({
      actorId: actor.accountId,
      actorRole: 'TEACHER',
      action: 'submission.files_purged',
      entityType: 'submission',
      entityId: submission.id,
      after: { removed },
      source: actor.source,
      ip: actor.ip,
    });
    return removed;
  }

  async execute(actor: Actor, input: ReviewInput): Promise<SubmissionReviewRow> {
    assertRole(actor, 'TEACHER');
    const comment = (input.comment ?? '').trim();
    if (comment.length > MAX_REVIEW_COMMENT_LENGTH)
      throw AppError.validation('The comment is too long', { max: MAX_REVIEW_COMMENT_LENGTH });
    if (input.decision === 'returned' && !comment)
      throw AppError.validation('A comment is required to return the work', { reason: 'comment_required' });
    const fileIds = [...new Set(input.fileIds ?? [])];
    const now = this.clock.now();
    return this.txm.run(async () => {
      const submission = await this.own(actor, input.submissionId, true);
      if (await this.submissions.findReview(submission.id))
        throw new AppError('CONFLICT', 'The submission is already reviewed', { reason: 'reviewed' });
      const target = (await this.assignments.findTarget(submission.targetId, { forUpdate: true }))!;
      if (target.status === 'withdrawn')
        throw new AppError('CONFLICT', 'The assignment was withdrawn from the student', {
          reason: 'withdrawn',
        });
      const latest = (await this.submissions.listByTarget(target.id))[0];
      if (latest && latest.id !== submission.id)
        throw new AppError('CONFLICT', 'A newer attempt exists', { reason: 'superseded' });
      const attached = await this.files.markAttached(fileIds, actor.accountId, now, {
        uploadedBy: actor.accountId,
      });
      if (attached.length !== fileIds.length)
        throw new AppError('CONFLICT', 'Some files are no longer available', { reason: 'files_expired' });
      const review = await this.submissions.insertReview(
        {
          submissionId: submission.id,
          reviewerId: actor.accountId,
          decision: input.decision,
          comment: comment || null,
          gradeEntryId: null,
          reviewedAt: now,
        },
        fileIds,
      );
      if (target.status === 'submitted')
        await this.assignments.updateTarget(target.id, {
          status: input.decision === 'accepted' ? 'accepted' : 'returned',
        });
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: 'TEACHER',
        action: `submission.${input.decision}`,
        entityType: 'submission',
        entityId: submission.id,
        after: { decision: input.decision, hasComment: comment.length > 0, files: fileIds.length },
        source: actor.source,
        ip: actor.ip,
      });
      await this.outbox.publish({
        type: 'submission.reviewed',
        aggregateType: 'submission',
        aggregateId: submission.id,
        payload: {
          submissionId: submission.id,
          reviewId: review.id,
          assignmentId: submission.assignmentId,
          teacherId: submission.teacherId,
          studentId: submission.studentId,
          decision: input.decision,
          hasComment: comment.length > 0,
          files: fileIds.length,
        },
      });
      return review;
    });
  }
}
