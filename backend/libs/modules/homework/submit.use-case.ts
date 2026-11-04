import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { type Actor, assertRole } from '@modules/access/actor.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { FileRepository } from '@modules/files/file.repository.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { AssignmentRepository } from './assignment.repository.js';
import { assertCanSubmit, isLate, MAX_SUBMISSION_TEXT_LENGTH } from './homework.rules.js';
import type { AssignmentRow, AssignmentTargetRow, SubmissionRow } from './schema.js';
import { SubmissionRepository } from './submission.repository.js';

export interface SubmitInput {
  assignmentId: string;
  /** Draft files already stored by IngestFileUseCase (owner = the teacher), in the order sent. */
  fileIds: readonly string[];
  text?: string | null;
}

export interface StudentAssignment {
  assignment: AssignmentRow;
  target: AssignmentTargetRow;
}

/**
 * UC-27 (5.10.3): the student hands in the draft collected by the bot. The target is locked; the rules of
 * 5.10.1 decide (late, resubmission, mode, file count); the files move from `draft` to `attached` (HW-06);
 * `submission.received` reaches the teacher (and the queue «На проверке»).
 */
@Injectable()
export class SubmitUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly assignments: AssignmentRepository,
    private readonly submissions: SubmissionRepository,
    private readonly files: FileRepository,
    private readonly links: TeacherStudentRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  /** The assignment as the student may see it (their own target, link still active), or NOT_FOUND. */
  async forStudent(actor: Actor, assignmentId: string): Promise<StudentAssignment> {
    assertRole(actor, 'STUDENT');
    const assignment = await this.assignments.findById(assignmentId);
    const target = assignment ? await this.assignments.findTargetOf(assignment.id, actor.accountId) : null;
    if (!assignment || !target || assignment.status === 'draft')
      throw AppError.notFound('assignment', assignmentId);
    const link = await this.links.findByPair(assignment.teacherId, actor.accountId);
    if (link?.status !== 'active') throw AppError.notFound('assignment', assignmentId);
    return { assignment, target };
  }

  async markViewed(actor: Actor, assignmentId: string): Promise<void> {
    const { target } = await this.forStudent(actor, assignmentId);
    if (!target.viewedAt) await this.assignments.updateTarget(target.id, { viewedAt: this.clock.now() });
  }

  async execute(actor: Actor, input: SubmitInput): Promise<SubmissionRow> {
    assertRole(actor, 'STUDENT');
    const text = (input.text ?? '').trim();
    if (text.length > MAX_SUBMISSION_TEXT_LENGTH)
      throw AppError.validation('The answer is too long', { max: MAX_SUBMISSION_TEXT_LENGTH });
    const fileIds = [...new Set(input.fileIds)];
    const now = this.clock.now();
    return this.txm.run(async () => {
      const { assignment } = await this.forStudent(actor, input.assignmentId);
      const target = (await this.assignments.findTargetOf(assignment.id, actor.accountId, {
        forUpdate: true,
      }))!;
      if (assignment.status !== 'published')
        throw new AppError('CONFLICT', 'The assignment is closed', { reason: 'closed' });
      const attempts = await this.submissions.listByTarget(target.id);
      const attemptNo = attempts.length + 1;
      assertCanSubmit(
        target.status,
        attemptNo,
        assignment.submissionMode,
        assignment.submissionRules,
        target.dueAt,
        now,
        {
          fileCount: fileIds.length,
          hasText: text.length > 0,
        },
      );
      // the files were ingested by this student against the teacher's quota; a purged or foreign id fails the whole submission
      const allowed = assignment.submissionRules.allowedExts;
      if (allowed) {
        const rows = await this.files.findByIds(fileIds);
        if (rows.some((f) => !allowed.includes(f.ext)))
          throw new AppError('FILE_TYPE_NOT_ALLOWED', 'File type is not accepted', { allowed });
      }
      const attached = await this.files.markAttached(fileIds, assignment.teacherId, now, {
        uploadedBy: actor.accountId,
      });
      if (attached.length !== fileIds.length)
        throw new AppError('CONFLICT', 'Some files are no longer available', { reason: 'files_expired' });
      const late = isLate(target.dueAt, now);
      const row = await this.submissions.insert(
        {
          assignmentId: assignment.id,
          targetId: target.id,
          teacherId: assignment.teacherId,
          studentId: actor.accountId,
          attemptNo,
          text: text || null,
          submittedAt: now,
          isLate: late,
        },
        fileIds,
      );
      await this.assignments.updateTarget(target.id, { status: 'submitted' });
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: 'STUDENT',
        action: 'submission.created',
        entityType: 'submission',
        entityId: row.id,
        after: {
          assignmentId: assignment.id,
          attemptNo,
          files: fileIds.length,
          hasText: text.length > 0,
          isLate: late,
        },
        source: actor.source,
        ip: actor.ip,
      });
      await this.outbox.publish({
        type: 'submission.received',
        aggregateType: 'submission',
        aggregateId: row.id,
        payload: {
          submissionId: row.id,
          assignmentId: assignment.id,
          targetId: target.id,
          teacherId: assignment.teacherId,
          studentId: actor.accountId,
          attemptNo,
          isLate: late,
          files: fileIds.length,
        },
      });
      return row;
    });
  }
}
