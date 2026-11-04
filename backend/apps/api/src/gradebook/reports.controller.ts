import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '@shared/http/zod-validation.pipe.js';
import type { Actor } from '@modules/access/actor.js';
import { BearerAuthGuard, CurrentActor, RequireRoles } from '@modules/access/http/bearer-auth.guard.js';
import {
  MAX_REPORT_COMMENT_LENGTH,
  ReportsUseCase,
  type ReportView,
} from '@modules/gradebook/reports.use-case.js';
import { uuidParam } from '../admin/admin.schemas.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const createBody = z
  .object({
    linkId: z.string().uuid(),
    from: isoDate,
    to: isoDate,
    comment: z.string().trim().max(MAX_REPORT_COMMENT_LENGTH).nullable().optional(),
    /** `true` sends at once (the usual path of the bot). */
    send: z.boolean().optional(),
  })
  .strict();
const listQuery = z.object({ linkId: z.string().uuid() }).strict();
const sendBody = z
  .object({ comment: z.string().trim().max(MAX_REPORT_COMMENT_LENGTH).nullable().optional() })
  .strict();

const view = (v: ReportView) => ({
  id: v.report.id,
  linkId: v.report.teacherStudentId,
  studentId: v.report.studentId,
  periodFrom: v.report.periodFrom,
  periodTo: v.report.periodTo,
  status: v.report.status,
  comment: v.report.comment,
  sentAt: v.report.sentAt?.toISOString() ?? null,
  createdAt: v.report.createdAt.toISOString(),
  snapshot: v.snapshot,
});

/** 9.2 «Reports»: `POST /reports` (draft or sent), `POST /reports/{id}/send`, `GET /reports/{id}`, `GET /reports?linkId` (M6-03). */
@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(BearerAuthGuard)
@RequireRoles('TEACHER')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsUseCase) {}

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(listQuery)) q: z.infer<typeof listQuery>,
  ) {
    return (await this.reports.listForTeacher(actor, q.linkId)).map(view);
  }

  @Post()
  async create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createBody)) body: z.infer<typeof createBody>,
  ) {
    const row = await this.reports.create(actor, body);
    if (body.send) await this.reports.send(actor, row.id);
    return view(await this.reports.teacherReport(actor, row.id));
  }

  @Get(':id')
  async get(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(uuidParam)) id: string) {
    return view(await this.reports.teacherReport(actor, id));
  }

  @Post(':id/send')
  async send(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(sendBody)) body: z.infer<typeof sendBody>,
  ) {
    await this.reports.send(actor, id, body.comment);
    return view(await this.reports.teacherReport(actor, id));
  }
}
