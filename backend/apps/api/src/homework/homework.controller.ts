import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '@shared/http/zod-validation.pipe.js';
import type { Actor } from '@modules/access/actor.js';
import { BearerAuthGuard, CurrentActor, RequireRoles } from '@modules/access/http/bearer-auth.guard.js';
import { AssignmentsUseCase } from '@modules/homework/assignments.use-case.js';
import { HomeworkQuery, type SubmissionCard } from '@modules/homework/homework.query.js';
import {
  MAX_ASSIGNMENT_BODY_LENGTH,
  MAX_ASSIGNMENT_TITLE_LENGTH,
  MAX_FILES_PER_SUBMISSION,
  MAX_REVIEW_COMMENT_LENGTH,
} from '@modules/homework/homework.rules.js';
import { ReviewUseCase } from '@modules/homework/review.use-case.js';
import {
  type AssignmentRow,
  type AssignmentTargetRow,
  DUE_MODES,
  SUBMISSION_MODES,
} from '@modules/homework/schema.js';
import { uuidParam } from '../admin/admin.schemas.js';

const assignmentBody = z
  .object({
    title: z.string().trim().min(1).max(MAX_ASSIGNMENT_TITLE_LENGTH),
    body: z.string().trim().max(MAX_ASSIGNMENT_BODY_LENGTH).nullable().optional(),
    dueMode: z.enum(DUE_MODES),
    dueAt: z.coerce.date().nullable().optional(),
    assignedLessonId: z.string().uuid().nullable().optional(),
    checkLessonId: z.string().uuid().nullable().optional(),
    collectionId: z.string().uuid().nullable().optional(),
    submissionMode: z.enum(SUBMISSION_MODES),
    submissionRules: z
      .object({
        allowedExts: z.array(z.string().min(1).max(10)).min(1).optional(),
        maxFiles: z.number().int().min(1).max(MAX_FILES_PER_SUBMISSION).optional(),
        allowResubmit: z.boolean().optional(),
        acceptLate: z.boolean().optional(),
      })
      .strict()
      .optional(),
    studentIds: z.array(z.string().uuid()).max(200).optional(),
    groupIds: z.array(z.string().uuid()).max(20).optional(),
    draft: z.boolean().optional(),
  })
  .strict();
const reviewBody = z
  .object({
    decision: z.enum(['accepted', 'returned']),
    comment: z.string().trim().max(MAX_REVIEW_COMMENT_LENGTH).nullable().optional(),
    fileIds: z.array(z.string().uuid()).max(MAX_FILES_PER_SUBMISSION).optional(),
  })
  .strict();
const submissionsQuery = z.object({ status: z.enum(['submitted']).optional() }).strict();

const assignmentView = (a: AssignmentRow) => ({
  id: a.id,
  title: a.title,
  body: a.body,
  dueMode: a.dueMode,
  dueAt: a.dueAt?.toISOString() ?? null,
  assignedLessonId: a.assignedLessonId,
  checkLessonId: a.checkLessonId,
  collectionId: a.collectionId,
  submissionMode: a.submissionMode,
  submissionRules: a.submissionRules,
  grading: a.grading,
  status: a.status,
  publishedAt: a.publishedAt?.toISOString() ?? null,
  closedAt: a.closedAt?.toISOString() ?? null,
});
const targetView = (t: AssignmentTargetRow) => ({
  id: t.id,
  studentId: t.studentId,
  dueAt: t.dueAt?.toISOString() ?? null,
  status: t.status,
  viewedAt: t.viewedAt?.toISOString() ?? null,
});
const submissionView = (c: SubmissionCard) => ({
  id: c.submission.id,
  assignmentId: c.assignment.id,
  studentId: c.submission.studentId,
  attemptNo: c.submission.attemptNo,
  text: c.submission.text,
  submittedAt: c.submission.submittedAt.toISOString(),
  isLate: c.submission.isLate,
  fileIds: c.files.map((f) => f.id),
  review: c.review
    ? {
        decision: c.review.decision,
        comment: c.review.comment,
        reviewedAt: c.review.reviewedAt.toISOString(),
      }
    : null,
});

/** Homework of the calling teacher (9.2 "Homework"): assignments, publishing, closing, the review queue (M5-03/04). */
@ApiTags('homework')
@ApiBearerAuth()
@UseGuards(BearerAuthGuard)
@RequireRoles('TEACHER')
@Controller()
export class HomeworkController {
  constructor(
    private readonly assignments: AssignmentsUseCase,
    private readonly review: ReviewUseCase,
    private readonly query: HomeworkQuery,
  ) {}

  @Get('assignments')
  async list(@CurrentActor() actor: Actor) {
    return (await this.query.teacherList(actor.accountId)).map((it) => ({
      ...assignmentView(it.assignment),
      counts: it.counts,
    }));
  }

  @Post('assignments')
  async create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(assignmentBody)) body: z.infer<typeof assignmentBody>,
  ) {
    const { draft, ...input } = body;
    const row = await this.assignments.create(actor, input, { draft });
    return this.get(actor, row.id);
  }

  @Get('assignments/:id')
  async get(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(uuidParam)) id: string) {
    const card = await this.query.card(actor.accountId, id);
    return { ...assignmentView(card.assignment), targets: card.targets.map((t) => targetView(t.target)) };
  }

  @Post('assignments/:id/publish')
  async publish(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(uuidParam)) id: string) {
    await this.assignments.publish(actor, id);
    return this.get(actor, id);
  }

  @Post('assignments/:id/close')
  async close(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(uuidParam)) id: string) {
    await this.assignments.close(actor, id);
    return this.get(actor, id);
  }

  /** `?status=submitted` (the default) is the queue «На проверке», oldest first. */
  @Get('submissions')
  async submissions(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(submissionsQuery)) _q: z.infer<typeof submissionsQuery>,
  ) {
    return (await this.query.queue(actor.accountId)).map(submissionView);
  }

  /** Р-27: frees the storage taken by a reviewed submission (the student's and the teacher's files). */
  @Post('submissions/:id/files/purge')
  async purgeFiles(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(uuidParam)) id: string) {
    return { removed: await this.review.purgeFiles(actor, id) };
  }

  @Post('submissions/:id/review')
  async reviewSubmission(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(reviewBody)) body: z.infer<typeof reviewBody>,
  ) {
    await this.review.execute(actor, { submissionId: id, ...body });
    return submissionView(await this.query.submissionCard(actor.accountId, id));
  }
}
