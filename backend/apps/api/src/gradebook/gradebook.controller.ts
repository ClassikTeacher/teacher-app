import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '@shared/http/zod-validation.pipe.js';
import type { Actor } from '@modules/access/actor.js';
import { BearerAuthGuard, CurrentActor, RequireRoles } from '@modules/access/http/bearer-auth.guard.js';
import { GradeEntriesUseCase } from '@modules/gradebook/grade-entries.use-case.js';
import { type JournalCard, GradebookQuery } from '@modules/gradebook/gradebook.query.js';
import {
  MAX_ENTRY_COMMENT_LENGTH,
  MAX_ENTRY_WEIGHT,
  MAX_SCALE_LABEL_LENGTH,
  MAX_SCALE_TITLE_LENGTH,
  MAX_SCALE_VALUES,
  MAX_TEST_SCORE,
  MIN_SCALE_VALUES,
} from '@modules/gradebook/gradebook.rules.js';
import { JournalsUseCase } from '@modules/gradebook/journals.use-case.js';
import { type GradeEntryRow, type JournalRow, SCHOOL_CATEGORIES } from '@modules/gradebook/schema.js';
import { uuidParam } from '../admin/admin.schemas.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const valueBody = z
  .object({
    value: z.number().min(0).max(MAX_TEST_SCORE).nullable().optional(),
    max: z.number().positive().max(MAX_TEST_SCORE).nullable().optional(),
    parts: z
      .object({ a: z.number().min(0).optional(), b: z.number().min(0).optional() })
      .strict()
      .nullable()
      .optional(),
    scaleValueId: z.string().uuid().nullable().optional(),
    category: z.enum(SCHOOL_CATEGORIES).nullable().optional(),
    testKindId: z.string().uuid().nullable().optional(),
    weight: z.number().min(0).max(MAX_ENTRY_WEIGHT).nullable().optional(),
    comment: z.string().trim().max(MAX_ENTRY_COMMENT_LENGTH).nullable().optional(),
    date: isoDate.nullable().optional(),
    /** Tests: a draft file of the teacher (the scanned sheet). */
    fileId: z.string().uuid().nullable().optional(),
  })
  .strict();
const createBody = valueBody.extend({
  lessonId: z.string().uuid().nullable().optional(),
  assignmentId: z.string().uuid().nullable().optional(),
});
const settingsBody = z
  .object({
    visibleToStudent: z.boolean().optional(),
    visibleToParent: z.boolean().optional(),
    hidden: z.boolean().optional(),
    targetPercent: z.number().min(0).max(100).nullable().optional(),
  })
  .strict();
const scaleBody = z
  .object({
    title: z.string().trim().max(MAX_SCALE_TITLE_LENGTH).nullable().optional(),
    values: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(MAX_SCALE_LABEL_LENGTH),
            emoji: z.string().trim().max(16).nullable().optional(),
            weight: z.number().min(0).max(MAX_ENTRY_WEIGHT).nullable().optional(),
          })
          .strict(),
      )
      .min(MIN_SCALE_VALUES)
      .max(MAX_SCALE_VALUES),
  })
  .strict();
const statsQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() }).strict();
const decisionBody = z.object({ decision: z.enum(['confirmed', 'rejected']) }).strict();

const journalView = (j: JournalRow) => ({
  id: j.id,
  linkId: j.teacherStudentId,
  studentId: j.studentId,
  subjectId: j.subjectId,
  type: j.type,
  visibleToStudent: j.visibleToStudent,
  visibleToParent: j.visibleToParent,
  hidden: j.hidden,
  targetPercent: j.targetScore,
});
const entryView = (e: GradeEntryRow) => ({
  id: e.id,
  journalId: e.journalId,
  date: e.date,
  category: e.category,
  testKindId: e.testKindId,
  value: e.valueNumeric,
  max: e.valueMax,
  scaleValueId: e.scaleValueId,
  parts: e.parts,
  weight: e.weight,
  comment: e.comment,
  lessonId: e.lessonId,
  assignmentId: e.assignmentId,
  fileId: e.fileId,
  source: e.source,
  status: e.status,
  version: e.version,
  createdAt: e.createdAt.toISOString(),
});
const cardView = (c: JournalCard) => ({
  ...journalView(c.journal),
  subject: c.subject ? { id: c.subject.id, name: c.subject.name } : null,
  entries: c.entries.map(entryView),
  pending: c.pending.map(entryView),
  scaleValues: c.scaleValues.map((v) => ({ id: v.id, label: v.label, emoji: v.emoji, weight: v.weight })),
  testKinds: c.testKinds.map((k) => ({ id: k.id, name: k.name })),
  stats: c.stats,
  range: c.range,
});

/** 9.2 «Gradebook»: journals of a student, records, statistics, the custom scale (M6-01, M6-02). */
@ApiTags('gradebook')
@ApiBearerAuth()
@UseGuards(BearerAuthGuard)
@RequireRoles('TEACHER')
@Controller()
export class GradebookController {
  constructor(
    private readonly query: GradebookQuery,
    private readonly entries: GradeEntriesUseCase,
    private readonly journals: JournalsUseCase,
  ) {}

  /** `:id` is the student card (link) id, as everywhere under /students. */
  @Get('students/:id/journals')
  async journalsOf(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidParam)) linkId: string,
  ) {
    const view = await this.query.teacherJournals(actor, linkId);
    return view.journals.map((j) => ({
      ...journalView(j.journal),
      subject: j.subject ? { id: j.subject.id, name: j.subject.name } : null,
      count: j.count,
      last: j.last ? entryView(j.last) : null,
    }));
  }

  @Get('journals/:id')
  async journal(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(uuidParam)) id: string) {
    return cardView(await this.query.teacherCard(actor, id));
  }

  @Patch('journals/:id')
  async settings(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(settingsBody)) body: z.infer<typeof settingsBody>,
  ) {
    return journalView(await this.journals.updateSettings(actor, id, body));
  }

  @Get('journals/:id/entries')
  async list(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(uuidParam)) id: string) {
    const card = await this.query.teacherCard(actor, id);
    return { entries: card.entries.map(entryView), pending: card.pending.map(entryView) };
  }

  @Post('journals/:id/entries')
  async add(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(createBody)) body: z.infer<typeof createBody>,
  ) {
    return entryView(await this.entries.add(actor, { journalId: id, ...body }));
  }

  /** `GET /journals/{id}/stats?from&to` (9.2). */
  @Get('journals/:id/stats')
  async stats(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Query(new ZodValidationPipe(statsQuery)) q: z.infer<typeof statsQuery>,
  ) {
    const range = q.from && q.to ? { from: q.from, to: q.to } : null;
    const card = await this.query.teacherCard(actor, id, range);
    return { range: card.range, ...card.stats };
  }

  @Patch('entries/:id')
  async update(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(valueBody)) body: z.infer<typeof valueBody>,
  ) {
    return entryView(await this.entries.update(actor, id, body));
  }

  @Delete('entries/:id')
  @HttpCode(200)
  async remove(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(uuidParam)) id: string) {
    const row = await this.entries.remove(actor, id);
    return { id: row.id, removed: true };
  }

  /** UC-30: the teacher's decision on a proposed mark. */
  @Post('entries/:id/decision')
  async decide(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(decisionBody)) body: z.infer<typeof decisionBody>,
  ) {
    const row =
      body.decision === 'confirmed'
        ? await this.entries.confirm(actor, id)
        : await this.entries.reject(actor, id);
    return entryView(row);
  }

  @Get('grade-scales/custom')
  async scale(@CurrentActor() actor: Actor) {
    const view = await this.journals.customScale(actor);
    return view
      ? {
          id: view.scale.id,
          title: view.scale.title,
          values: view.values.map((v) => ({
            id: v.id,
            label: v.label,
            emoji: v.emoji,
            weight: v.weight,
            archived: v.archivedAt !== null,
          })),
        }
      : null;
  }

  @Put('grade-scales/custom')
  async putScale(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(scaleBody)) body: z.infer<typeof scaleBody>,
  ) {
    await this.journals.putCustomScale(actor, body);
    return this.scale(actor);
  }
}
