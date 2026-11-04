import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '@shared/http/zod-validation.pipe.js';
import type { Actor } from '@modules/access/actor.js';
import { BearerAuthGuard, CurrentActor, RequireRoles } from '@modules/access/http/bearer-auth.guard.js';
import {
  MAX_LESSON_DURATION_MIN,
  MIN_LESSON_DURATION_MIN,
} from '@modules/people/teacher-profile.defaults.js';
import {
  BulkCancelUseCase,
  MAX_BULK_RANGE_DAYS,
  type TeacherSelection,
} from '@modules/schedule/cancellations/bulk-cancel.use-case.js';
import { CancelLessonUseCase } from '@modules/schedule/cancellations/cancel-lesson.use-case.js';
import {
  MAX_RESCHEDULE_COMMENT_LENGTH,
  RescheduleLessonUseCase,
} from '@modules/schedule/reschedule/reschedule-lesson.use-case.js';
import { MAX_CANCEL_REASON_LENGTH } from '@modules/schedule/cancellations/cancel.rules.js';
import { CreateLessonUseCase } from '@modules/schedule/lessons/create-lesson.use-case.js';
import {
  MAX_LOCATION_LENGTH,
  MAX_MEETING_URL_LENGTH,
  MAX_TOPIC_LENGTH,
} from '@modules/schedule/lessons/lesson.rules.js';
import { type LessonView, LessonsQuery } from '@modules/schedule/lessons/lessons.query.js';
import { LESSON_FORMATS, LESSON_STATUSES } from '@modules/schedule/schema.js';
import { uuidParam } from '../admin/admin.schemas.js';

const isoDate = z
  .string()
  .datetime({ offset: true })
  .transform((v) => new Date(v));
/** Longest range one list call may cover (a quarter), to keep the hydration bounded. */
const MAX_LIST_RANGE_DAYS = 93;
const listQuery = z
  .object({
    from: isoDate,
    to: isoDate,
    status: z.enum(LESSON_STATUSES).optional(),
  })
  .refine((q) => q.to.getTime() > q.from.getTime(), { message: '`to` must be after `from`' })
  .refine((q) => q.to.getTime() - q.from.getTime() <= MAX_LIST_RANGE_DAYS * 864e5, {
    message: `range must not exceed ${MAX_LIST_RANGE_DAYS} days`,
  });
const createBody = z
  .object({
    studentId: z.string().uuid().optional(),
    groupId: z.string().uuid().optional(),
    startsAt: isoDate,
    durationMin: z.number().int().min(MIN_LESSON_DURATION_MIN).max(MAX_LESSON_DURATION_MIN),
    subjectId: z.string().uuid().nullable().optional(),
    plannedTopic: z.string().trim().max(MAX_TOPIC_LENGTH).nullable().optional(),
    format: z.enum(LESSON_FORMATS).nullable().optional(),
    location: z.string().trim().max(MAX_LOCATION_LENGTH).nullable().optional(),
    meetingUrl: z.string().trim().url().max(MAX_MEETING_URL_LENGTH).nullable().optional(),
  })
  .strict()
  .refine((b) => (b.studentId ? 1 : 0) + (b.groupId ? 1 : 0) === 1, {
    message: 'exactly one of studentId or groupId is required',
  });

const cancelBody = z
  .object({
    reason: z.string().trim().min(1).max(MAX_CANCEL_REASON_LENGTH),
    templateId: z.string().uuid().nullable().optional(),
  })
  .strict();

/** UC-22 over REST: several ids, or a period with an optional student / group; `dryRun` returns the preview. */
const bulkCancelBody = z
  .object({
    lessonIds: z.array(z.string().uuid()).max(200).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    studentId: z.string().uuid().optional(),
    groupId: z.string().uuid().optional(),
    reason: z.string().trim().max(MAX_CANCEL_REASON_LENGTH).optional(),
    templateId: z.string().uuid().nullable().optional(),
    closeWindows: z.boolean().optional(),
    dryRun: z.boolean().optional(),
  })
  .strict()
  .refine((b) => (b.lessonIds ? !b.from && !b.to : !!b.from && !!b.to), {
    message: 'either lessonIds or from and to are required',
  })
  .refine((b) => !(b.studentId && b.groupId), { message: 'studentId and groupId are exclusive' })
  .refine((b) => !b.closeWindows || (!!b.from && !b.studentId && !b.groupId), {
    message: 'closeWindows applies to a whole period only',
  })
  .refine((b) => !b.from || !b.to || b.to.getTime() - b.from.getTime() <= MAX_BULK_RANGE_DAYS * 864e5, {
    message: `range must not exceed ${MAX_BULK_RANGE_DAYS} days`,
  });

const rescheduleBody = z
  .object({
    startsAt: isoDate,
    durationMin: z.number().int().min(MIN_LESSON_DURATION_MIN).max(MAX_LESSON_DURATION_MIN).optional(),
    comment: z.string().trim().max(MAX_RESCHEDULE_COMMENT_LENGTH).nullable().optional(),
  })
  .strict();

function bulkSelection(b: z.infer<typeof bulkCancelBody>): TeacherSelection {
  if (b.lessonIds) return { lessonIds: b.lessonIds };
  const target = b.studentId ? { studentId: b.studentId } : b.groupId ? { groupId: b.groupId } : undefined;
  return { range: { start: b.from!, end: b.to! }, ...(target ? { target } : {}) };
}

function view(v: LessonView) {
  const { lesson } = v;
  return {
    id: lesson.id,
    status: lesson.status,
    startsAt: lesson.startsAt.toISOString(),
    endsAt: lesson.endsAt.toISOString(),
    groupId: lesson.groupId,
    seriesId: lesson.seriesId,
    seqNo: lesson.seqNo,
    subject: v.subject ? { id: v.subject.id, name: v.subject.name } : null,
    plannedTopic: lesson.plannedTopic,
    topic: lesson.topic,
    format: lesson.format,
    location: lesson.location,
    meetingUrl: lesson.meetingUrl,
    outsideWindows: lesson.outsideWindows,
    version: lesson.version,
    participants: v.participants.map((p) => ({
      studentId: p.student.id,
      displayName: p.displayName,
      attendance: p.participant.attendance,
    })),
  };
}

/** 9.2 "Lessons" (teacher only): list by range, create (UC-14), read one. */
@ApiTags('lessons')
@ApiBearerAuth()
@UseGuards(BearerAuthGuard)
@RequireRoles('TEACHER')
@Controller('lessons')
export class LessonsController {
  constructor(
    private readonly create: CreateLessonUseCase,
    private readonly cancel: CancelLessonUseCase,
    private readonly bulk: BulkCancelUseCase,
    private readonly reschedule: RescheduleLessonUseCase,
    private readonly query: LessonsQuery,
  ) {}

  /** UC-18 (5.7.4): the teacher moves the lesson; everyone's occupancy is checked (CAL-01), the comment is optional. */
  @Post(':id/reschedule')
  async rescheduleLesson(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(rescheduleBody)) body: z.infer<typeof rescheduleBody>,
  ) {
    await this.reschedule.execute(actor, {
      lessonId: id,
      startsAt: body.startsAt,
      durationMin: body.durationMin,
      comment: body.comment,
    });
    return view(await this.query.teacherLesson(actor.accountId, id));
  }

  /** 5.7.5 (feature `bulk.cancel`): preview with `dryRun`, otherwise one transaction (CNL-10). */
  @Post('bulk-cancel')
  async bulkCancel(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(bulkCancelBody)) body: z.infer<typeof bulkCancelBody>,
  ) {
    const selection = bulkSelection(body);
    const result = body.dryRun
      ? { ...(await this.bulk.previewTeacher(actor, selection)), cancellationId: null, closedDays: [] }
      : await this.bulk.executeTeacher(actor, selection, {
          reason: body.reason ?? '',
          templateId: body.templateId,
          closeWindows: body.closeWindows,
        });
    return {
      cancellationId: result.cancellationId,
      lateCount: result.lateCount,
      closedDays: result.closedDays,
      items: result.items.map((i) => ({
        lessonId: i.lesson.id,
        startsAt: i.lesson.startsAt.toISOString(),
        isLate: i.isLate,
      })),
      excluded: result.excluded.map((e) => ({ lessonId: e.lesson.id, code: e.code })),
    };
  }

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(listQuery)) q: z.infer<typeof listQuery>,
  ) {
    const items = await this.query.teacherLessons(
      actor.accountId,
      { start: q.from, end: q.to },
      q.status ? [q.status] : undefined,
    );
    return items.map(view);
  }

  @Post()
  async createLesson(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createBody)) body: z.infer<typeof createBody>,
  ) {
    const { studentId, groupId, ...rest } = body;
    const target = studentId ? { studentId } : { groupId: groupId! };
    const { lesson } = await this.create.execute(actor, { ...rest, target });
    return view(await this.query.teacherLesson(actor.accountId, lesson.id));
  }

  @Get(':id')
  async get(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(uuidParam)) id: string) {
    return view(await this.query.teacherLesson(actor.accountId, id));
  }

  /** UC-20 by the teacher (5.7.3): the reason is mandatory (CNL-01); allowed until the lesson ends (CNL-02). */
  @Post(':id/cancel')
  async cancelLesson(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(cancelBody)) body: z.infer<typeof cancelBody>,
  ) {
    const result = await this.cancel.execute(actor, {
      lessonId: id,
      reason: body.reason,
      templateId: body.templateId,
      as: 'TEACHER',
    });
    return { ...view(await this.query.teacherLesson(actor.accountId, id)), isLate: result.isLate };
  }
}
