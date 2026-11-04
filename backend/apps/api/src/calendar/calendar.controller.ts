import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '@shared/http/zod-validation.pipe.js';
import type { Actor } from '@modules/access/actor.js';
import { BearerAuthGuard, CurrentActor } from '@modules/access/http/bearer-auth.guard.js';
import { BusyQuery } from '@modules/schedule/occupancy/busy.query.js';

const busyQuery = z.object({
  accountId: z.string().uuid(),
  from: z
    .string()
    .datetime({ offset: true })
    .transform((v) => new Date(v)),
  to: z
    .string()
    .datetime({ offset: true })
    .transform((v) => new Date(v)),
});

/** 9.2 "Calendar": busy time only as intervals (CAL-07) and open slots (5.5.4); visibility by 5.5.3. */
@ApiTags('calendar')
@ApiBearerAuth()
@UseGuards(BearerAuthGuard)
@Controller('calendar')
export class CalendarController {
  constructor(private readonly busy: BusyQuery) {}

  @Get('busy')
  async busyIntervals(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(busyQuery)) q: z.infer<typeof busyQuery>,
  ) {
    const intervals = await this.busy.busy(actor, q.accountId, { start: q.from, end: q.to });
    return {
      accountId: q.accountId,
      busy: intervals.map((i) => ({ startsAt: i.start.toISOString(), endsAt: i.end.toISOString() })),
    };
  }
}
