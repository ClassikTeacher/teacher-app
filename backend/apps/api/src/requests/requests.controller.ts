import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '@shared/http/zod-validation.pipe.js';
import type { Actor } from '@modules/access/actor.js';
import { BearerAuthGuard, CurrentActor, RequireRoles } from '@modules/access/http/bearer-auth.guard.js';
import { MAX_RESCHEDULE_COMMENT_LENGTH } from '@modules/schedule/reschedule/reschedule-lesson.use-case.js';
import {
  type RequestView,
  RescheduleRequestUseCase,
} from '@modules/schedule/reschedule/reschedule-request.use-case.js';
import { uuidParam } from '../admin/admin.schemas.js';

const declineBody = z
  .object({ message: z.string().trim().min(1).max(MAX_RESCHEDULE_COMMENT_LENGTH) })
  .strict();
const acceptBody = z
  .object({ message: z.string().trim().max(MAX_RESCHEDULE_COMMENT_LENGTH).optional() })
  .strict();

function view(v: RequestView) {
  const { request } = v;
  return {
    id: request.id,
    kind: request.kind,
    status: request.status,
    studentId: request.studentId,
    lessonId: request.lessonId,
    lessonStartsAt: v.lesson?.startsAt.toISOString() ?? null,
    startsAt: request.startsAt?.toISOString() ?? null,
    endsAt: request.endsAt?.toISOString() ?? null,
    comment: request.comment,
    decisionReason: request.decisionReason,
    createdAt: request.createdAt.toISOString(),
  };
}

/** 9.2 "Requests" (teacher only): open requests and decisions (5.5.5, 5.7.4). */
@ApiTags('requests')
@ApiBearerAuth()
@UseGuards(BearerAuthGuard)
@RequireRoles('TEACHER')
@Controller('booking-requests')
export class RequestsController {
  constructor(private readonly requests: RescheduleRequestUseCase) {}

  @Get()
  async list(@CurrentActor() actor: Actor) {
    return (await this.requests.pendingForTeacher(actor)).map(view);
  }

  @Get(':id')
  async get(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(uuidParam)) id: string) {
    return view(await this.requests.view(actor, id));
  }

  @Post(':id/accept')
  async accept(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(acceptBody)) body: z.infer<typeof acceptBody>,
  ) {
    await this.requests.decide(actor, { requestId: id, accept: true, message: body.message });
    return view(await this.requests.view(actor, id));
  }

  @Post(':id/decline')
  async decline(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(declineBody)) body: z.infer<typeof declineBody>,
  ) {
    await this.requests.decide(actor, { requestId: id, accept: false, message: body.message });
    return view(await this.requests.view(actor, id));
  }
}
