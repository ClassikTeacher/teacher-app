import { Injectable } from '@nestjs/common';
import { AppError } from '@shared/errors/app-error.js';
import { FileRepository } from '@modules/files/file.repository.js';
import type { FileRow } from '@modules/files/schema.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import type { AccountRow } from '@modules/identity/schema.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { AssignmentRepository } from './assignment.repository.js';
import type {
  AssignmentRow,
  AssignmentTargetRow,
  SubmissionReviewRow,
  SubmissionRow,
  TargetStatus,
} from './schema.js';
import { SubmissionRepository } from './submission.repository.js';

export interface TeacherAssignmentItem {
  assignment: AssignmentRow;
  counts: Record<TargetStatus, number>;
}

export interface TargetView {
  target: AssignmentTargetRow;
  student: AccountRow | null;
  /** The latest attempt, if any. */
  submission: SubmissionRow | null;
  review: SubmissionReviewRow | null;
}

export interface AssignmentCard {
  assignment: AssignmentRow;
  teacher: AccountRow | null;
  targets: TargetView[];
}

export interface SubmissionCard {
  submission: SubmissionRow;
  assignment: AssignmentRow;
  target: AssignmentTargetRow;
  student: AccountRow | null;
  files: FileRow[];
  review: SubmissionReviewRow | null;
  reviewFiles: FileRow[];
}

export interface StudentAssignmentItem {
  assignment: AssignmentRow;
  target: AssignmentTargetRow;
  teacher: AccountRow | null;
}

export interface AttemptView {
  submission: SubmissionRow;
  review: SubmissionReviewRow | null;
  reviewFiles: FileRow[];
}

/** 5.10.5: what the reports (M6-03) need per student and period. */
export interface HomeworkStats {
  onTime: number;
  late: number;
  notSubmitted: number;
  accepted: number;
  returned: number;
}

const EMPTY_COUNTS: Record<TargetStatus, number> = {
  assigned: 0,
  submitted: 0,
  overdue: 0,
  returned: 0,
  accepted: 0,
  withdrawn: 0,
};

/** Read side for the bots and REST; ownership by teacher_id or by target (8.0). */
@Injectable()
export class HomeworkQuery {
  constructor(
    private readonly assignments: AssignmentRepository,
    private readonly submissions: SubmissionRepository,
    private readonly files: FileRepository,
    private readonly accounts: AccountRepository,
    private readonly links: TeacherStudentRepository,
  ) {}

  async teacherList(
    teacherId: string,
    statuses?: readonly AssignmentRow['status'][],
  ): Promise<TeacherAssignmentItem[]> {
    const rows = await this.assignments.listByTeacher(teacherId, statuses);
    const counts = await this.assignments.countByStatus(rows.map((r) => r.id));
    return rows.map((assignment) => ({
      assignment,
      counts: counts.get(assignment.id) ?? { ...EMPTY_COUNTS },
    }));
  }

  async card(teacherId: string, assignmentId: string): Promise<AssignmentCard> {
    const assignment = await this.assignments.findById(assignmentId);
    if (!assignment || assignment.teacherId !== teacherId)
      throw AppError.notFound('assignment', assignmentId);
    const targets = await this.assignments.listTargets(assignment.id);
    const [students, submissions, teacher] = await Promise.all([
      this.accounts.findByIds(targets.map((t) => t.studentId)),
      this.submissions.listByTargets(targets.map((t) => t.id)),
      this.accounts.findById(teacherId),
    ]);
    const reviews = await this.submissions.listReviews(submissions.map((s) => s.id));
    const studentById = new Map(students.map((s) => [s.id, s]));
    const latestByTarget = new Map<string, SubmissionRow>();
    for (const s of submissions) latestByTarget.set(s.targetId, s); // ordered by submittedAt → last wins
    const reviewBySubmission = new Map(reviews.map((r) => [r.submissionId, r]));
    return {
      assignment,
      teacher,
      targets: targets.map((target) => {
        const submission = latestByTarget.get(target.id) ?? null;
        return {
          target,
          student: studentById.get(target.studentId) ?? null,
          submission,
          review: submission ? (reviewBySubmission.get(submission.id) ?? null) : null,
        };
      }),
    };
  }

  /** «На проверке (N)»: oldest first (5.10.4), hydrated in a handful of batched queries. */
  async queue(teacherId: string): Promise<SubmissionCard[]> {
    const rows = await this.submissions.listUnreviewed(teacherId);
    if (rows.length === 0) return [];
    const assignmentIds = [...new Set(rows.map((r) => r.assignmentId))];
    const [assignments, targets, students, fileRows, reviews] = await Promise.all([
      this.assignments.findByIds(assignmentIds),
      this.assignments.listTargetsOf(assignmentIds),
      this.accounts.findByIds([...new Set(rows.map((r) => r.studentId))]),
      this.submissions.listFilesOf(rows.map((r) => r.id)),
      this.submissions.listReviews(rows.map((r) => r.id)),
    ]);
    const fileById = new Map(
      (await this.files.findByIds([...new Set(fileRows.map((f) => f.fileId))])).map((f) => [f.id, f]),
    );
    const byAssignment = new Map(assignments.map((a) => [a.id, a]));
    const byTarget = new Map(targets.map((t) => [t.id, t]));
    const byStudent = new Map(students.map((s) => [s.id, s]));
    const byReview = new Map(reviews.map((r) => [r.submissionId, r]));
    return rows.map((submission) => ({
      submission,
      assignment: byAssignment.get(submission.assignmentId)!,
      target: byTarget.get(submission.targetId)!,
      student: byStudent.get(submission.studentId) ?? null,
      files: fileRows
        .filter((f) => f.submissionId === submission.id)
        .flatMap((f) => (fileById.has(f.fileId) ? [fileById.get(f.fileId)!] : [])),
      review: byReview.get(submission.id) ?? null,
      reviewFiles: [], // not shown in the queue list
    }));
  }

  /** One assignment of the student with its target and the teacher (the card in StudentBot). */
  async studentItem(studentId: string, assignmentId: string): Promise<StudentAssignmentItem | null> {
    const assignment = await this.assignments.findById(assignmentId);
    const target = assignment ? await this.assignments.findTargetOf(assignment.id, studentId) : null;
    if (!assignment || !target) return null;
    return { assignment, target, teacher: await this.accounts.findById(assignment.teacherId) };
  }

  async queueCount(teacherId: string): Promise<number> {
    return this.submissions.countUnreviewed(teacherId);
  }

  async submissionCard(teacherId: string, submissionId: string): Promise<SubmissionCard> {
    const submission = await this.submissions.findById(submissionId);
    if (!submission || submission.teacherId !== teacherId)
      throw AppError.notFound('submission', submissionId);
    return this.hydrateSubmission(submission);
  }

  async hydrateSubmission(submission: SubmissionRow): Promise<SubmissionCard> {
    const [assignment, target, student, fileRows, review] = await Promise.all([
      this.assignments.findById(submission.assignmentId),
      this.assignments.findTarget(submission.targetId),
      this.accounts.findById(submission.studentId),
      this.submissions.listFiles(submission.id),
      this.submissions.findReview(submission.id),
    ]);
    const files = await this.files.findByIds(fileRows.map((f) => f.fileId));
    const reviewFiles = review ? await this.reviewFiles(review) : [];
    return { submission, assignment: assignment!, target: target!, student, files, review, reviewFiles };
  }

  /** StudentBot → Задания: open work first (nearest due, overdue included), then finished. */
  async studentList(studentId: string, statuses: readonly TargetStatus[]): Promise<StudentAssignmentItem[]> {
    const targets = await this.assignments.listTargetsByStudent(studentId, statuses);
    const assignments = await this.assignments.findByIds(targets.map((t) => t.assignmentId));
    const byId = new Map(assignments.map((a) => [a.id, a]));
    const teachers = await this.accounts.findByIds([...new Set(assignments.map((a) => a.teacherId))]);
    const teacherById = new Map(teachers.map((t) => [t.id, t]));
    const activeLinks = new Set(
      (await this.links.listByStudent(studentId, ['active'])).map((l) => l.teacherId),
    );
    const items: StudentAssignmentItem[] = [];
    for (const target of targets) {
      const assignment = byId.get(target.assignmentId);
      if (!assignment || assignment.status === 'draft' || !activeLinks.has(assignment.teacherId)) continue;
      items.push({ assignment, target, teacher: teacherById.get(assignment.teacherId) ?? null });
    }
    return items;
  }

  /** The student's attempts and the teacher's verdicts for one assignment, newest first. */
  async studentHistory(targetId: string): Promise<AttemptView[]> {
    const rows = await this.submissions.listByTarget(targetId);
    const reviews = await this.submissions.listReviews(rows.map((r) => r.id));
    const reviewFileRows = await this.submissions.listReviewFilesOf(reviews.map((r) => r.id));
    const fileById = new Map(
      (await this.files.findByIds([...new Set(reviewFileRows.map((f) => f.fileId))])).map((f) => [f.id, f]),
    );
    const byReview = new Map(reviews.map((r) => [r.submissionId, r]));
    return rows.map((submission) => {
      const review = byReview.get(submission.id) ?? null;
      const reviewFiles = review
        ? reviewFileRows
            .filter((f) => f.reviewId === review.id)
            .flatMap((f) => (fileById.has(f.fileId) ? [fileById.get(f.fileId)!] : []))
        : [];
      return { submission, review, reviewFiles };
    });
  }

  /** 5.10.5 statistics for a student at a teacher within a period (by the target's creation). */
  async stats(
    teacherId: string,
    studentId: string,
    range: { start: Date; end: Date },
  ): Promise<HomeworkStats> {
    const all = await this.assignments.listTargetsByStudent(
      studentId,
      ['assigned', 'overdue', 'returned', 'submitted', 'accepted'],
      teacherId,
    );
    const inRange = all.filter((t) => t.createdAt >= range.start && t.createdAt < range.end);
    const submissions = await this.submissions.listByTargets(inRange.map((t) => t.id));
    const first = new Map<string, SubmissionRow>();
    for (const s of submissions) if (!first.has(s.targetId)) first.set(s.targetId, s);
    const stats: HomeworkStats = { onTime: 0, late: 0, notSubmitted: 0, accepted: 0, returned: 0 };
    for (const t of inRange) {
      const s = first.get(t.id);
      if (!s) stats.notSubmitted += 1;
      else if (s.isLate) stats.late += 1;
      else stats.onTime += 1;
      if (t.status === 'accepted') stats.accepted += 1;
      if (t.status === 'returned') stats.returned += 1;
    }
    return stats;
  }

  private async reviewFiles(review: SubmissionReviewRow): Promise<FileRow[]> {
    const rows = await this.submissions.listReviewFiles(review.id);
    return this.files.findByIds(rows.map((f) => f.fileId));
  }
}
