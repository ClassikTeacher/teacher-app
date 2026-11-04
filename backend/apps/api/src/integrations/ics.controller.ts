import { Controller, Get, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ZodValidationPipe } from '@shared/http/zod-validation.pipe.js';
import type { Actor } from '@modules/access/actor.js';
import { BearerAuthGuard, CurrentActor } from '@modules/access/http/bearer-auth.guard.js';
import { IcsUseCase } from '@modules/integrations/ics.use-case.js';

const tokenParam = z.string().regex(/^[A-Za-z0-9_-]{43}(\.ics)?$/);

/**
 * 5.14.2: `GET /ics/{token}.ics` is the subscription itself — the token is the secret, no other auth; the
 * calendar is written straight to the reply (text/calendar, not the JSON envelope). `POST /ics/rotate` re-issues
 * the link of the calling account (9.2).
 */
@ApiTags('integrations')
@Controller('ics')
export class IcsController {
  constructor(private readonly ics: IcsUseCase) {}

  @Get(':token')
  async feed(
    @Param('token', new ZodValidationPipe(tokenParam)) token: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const body = await this.ics.feed(token.replace(/\.ics$/, ''));
    await reply
      .header('Content-Type', 'text/calendar; charset=utf-8')
      .header('Cache-Control', 'private, max-age=600')
      .header('Content-Disposition', 'inline; filename="schedule.ics"')
      .send(body);
  }

  @Post('rotate')
  @ApiBearerAuth()
  @UseGuards(BearerAuthGuard)
  async rotate(@CurrentActor() actor: Actor) {
    return { url: await this.ics.rotate(actor) };
  }
}
