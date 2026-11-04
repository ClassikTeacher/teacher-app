import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { z } from 'zod';
import { BOT_KINDS, type BotKind } from '@shared/config/env.schema.js';
import { AppError } from '@shared/errors/app-error.js';
import { ZodValidationPipe } from '@shared/http/zod-validation.pipe.js';
import { TelegramGateway } from '@telegram/gateway/telegram.gateway.js';
import { WebhookSecretGuard } from './webhook.guard.js';

const updateSchema = z.object({ update_id: z.number().int().nonnegative() }).passthrough();

/** POST /api/v1/tg/{bot}/webhook — the secret guard runs first, then body validation, then dispatch. */
@ApiExcludeController()
@UseGuards(WebhookSecretGuard)
@Controller('tg')
export class WebhookController {
  constructor(private readonly gateway: TelegramGateway) {}

  @Post(':bot/webhook')
  @HttpCode(200)
  receive(
    @Param('bot') bot: string,
    @Body(new ZodValidationPipe(updateSchema)) update: z.infer<typeof updateSchema>,
  ): { ok: true } {
    if (!BOT_KINDS.includes(bot as BotKind)) throw AppError.notFound('bot', bot);
    this.gateway.dispatchWebhook(bot as BotKind, update);
    return { ok: true };
  }
}
