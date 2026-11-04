import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '@shared/http/zod-validation.pipe.js';
import type { Actor } from '@modules/access/actor.js';
import { BearerAuthGuard, CurrentActor } from '@modules/access/http/bearer-auth.guard.js';
import { OpenSlotsQuery } from '@modules/schedule/availability/open-slots.query.js';

const slotsQuery = z.object({
  teacherId: z.string().uuid(),
  studentId: z.string().uuid().optional(),
  from: z
    .string()
    .datetime({ offset: true })
    .transform((v) => new Date(v)),
  to: z
    .string()
    .datetime({ offset: true })
    .transform((v) => new Date(v)),
  durationMin: z.coerce.number().int().min(15).max(480).optional(),
});

/** 9.2 "Calendar": `GET /availability/slots` — open slots of a teacher (5.5.4, CAL-08; visibility 5.5.3). */
@ApiTags('calendar')
@ApiBearerAuth()
@UseGuards(BearerAuthGuard)
@Controller('availability')
export class AvailabilityController {
  constructor(private readonly openSlots: OpenSlotsQuery) {}

  @Get('slots')
  async slots(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(slotsQuery)) q: z.infer<typeof slotsQuery>,
  ) {
    const result = await this.openSlots.slots(actor, {
      teacherId: q.teacherId,
      ...(q.studentId ? { studentId: q.studentId } : {}),
      range: { start: q.from, end: q.to },
      ...(q.durationMin ? { durationMin: q.durationMin } : {}),
    });
    return {
      teacherId: q.teacherId,
      durationMin: result.durationMin,
      durations: result.durations,
      gridStepMin: result.gridStepMin,
      slots: result.slots.map((i) => ({ startsAt: i.start.toISOString(), endsAt: i.end.toISOString() })),
    };
  }
}
