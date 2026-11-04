import { Body, Controller, Delete, Get, Inject, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ENV, type Env } from '@shared/config/index.js';
import { AppError } from '@shared/errors/app-error.js';
import { ZodValidationPipe } from '@shared/http/zod-validation.pipe.js';
import type { Actor } from '@modules/access/actor.js';
import { BearerAuthGuard, CurrentActor, RequireRoles } from '@modules/access/http/bearer-auth.guard.js';
import {
  GoogleCalendarUseCase,
  type GoogleStatus,
} from '@modules/integrations/google/google-calendar.use-case.js';

const callbackQuery = z.object({
  state: z.string().max(128).optional(),
  code: z.string().max(2048).optional(),
  error: z.string().max(128).optional(),
});
const settingsBody = z
  .object({
    importEnabled: z.boolean().optional(),
    exportEnabled: z.boolean().optional(),
    busyCalendarIds: z.array(z.string().min(1).max(254)).min(1).max(5).optional(),
  })
  .strict();

function statusView(s: GoogleStatus) {
  if (!s.connected) return { configured: s.configured, connected: false };
  return {
    configured: true,
    connected: true,
    status: s.status,
    email: s.email,
    importEnabled: s.importEnabled,
    exportEnabled: s.exportEnabled,
    busyCalendarIds: s.busyCalendarIds,
    lastImportAt: s.lastImportAt?.toISOString() ?? null,
    lastExportAt: s.lastExportAt?.toISOString() ?? null,
    lastError: s.lastError,
  };
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The page Google redirects to; plain HTML with a link back to the bot (the teacher started from Telegram). */
function page(title: string, text: string, botUrl: string | null): string {
  const back = botUrl ? `<p><a href="${esc(botUrl)}">Вернуться в бот</a></p>` : '';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style></head><body><h1>${esc(title)}</h1><p>${esc(text)}</p>${back}</body></html>`;
}

/**
 * 5.14.1 / UC-43: the teacher's Google Calendar connection. `GET …/callback` is the OAuth redirect target —
 * public, the one-time `state` is its credential; everything else needs the teacher's bearer token (9.2).
 */
@ApiTags('integrations')
@Controller('integrations/google')
export class GoogleController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly google: GoogleCalendarUseCase,
  ) {}

  @Get()
  @ApiBearerAuth()
  @UseGuards(BearerAuthGuard)
  @RequireRoles('TEACHER')
  async status(@CurrentActor() actor: Actor) {
    return statusView(await this.google.status(actor));
  }

  @Post('connect')
  @ApiBearerAuth()
  @UseGuards(BearerAuthGuard)
  @RequireRoles('TEACHER')
  async connect(@CurrentActor() actor: Actor) {
    return { url: await this.google.connectUrl(actor) };
  }

  @Get('callback')
  async callback(
    @Query(new ZodValidationPipe(callbackQuery)) q: z.infer<typeof callbackQuery>,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const botUrl = `https://t.me/${this.env.BOT_STAFF_USERNAME}`;
    const send = async (status: number, title: string, text: string): Promise<void> => {
      await reply
        .status(status)
        .header('Content-Type', 'text/html; charset=utf-8')
        .header('Cache-Control', 'no-store')
        .send(page(title, text, botUrl));
    };
    if (q.error || !q.state || !q.code) {
      await send(
        400,
        'Google Calendar не подключён',
        q.error === 'access_denied'
          ? 'Вы не предоставили доступ. Чтобы подключить календарь, начните заново из бота и подтвердите оба разрешения.'
          : 'Ссылка неполная. Начните подключение заново из бота.',
      );
      return;
    }
    try {
      const { email } = await this.google.completeOAuth(q.state, q.code);
      await send(
        200,
        'Google Calendar подключён',
        `Аккаунт ${email ?? 'Google'} связан с платформой. Занятия появятся в календаре «Занятия (Tutor Platform)» в течение минуты. Эту вкладку можно закрыть.`,
      );
    } catch (error) {
      if (AppError.is(error, 'NOT_FOUND')) {
        await send(
          404,
          'Ссылка устарела',
          'Подключение не завершено: ссылка уже использована или истекла (15 минут). Начните заново из бота.',
        );
        return;
      }
      if (AppError.is(error, 'FEATURE_DISABLED')) {
        await send(403, 'Функция отключена', 'Интеграция с Google Calendar отключена администратором.');
        return;
      }
      if (AppError.is(error, 'VALIDATION_ERROR') || AppError.is(error, 'CONFLICT')) {
        await send(
          400,
          'Google Calendar не подключён',
          'Google не выдал нужные разрешения. Отзовите доступ приложения в настройках Google-аккаунта и подключите заново, отметив оба разрешения.',
        );
        return;
      }
      throw error;
    }
  }

  @Patch()
  @ApiBearerAuth()
  @UseGuards(BearerAuthGuard)
  @RequireRoles('TEACHER')
  async update(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(settingsBody)) body: z.infer<typeof settingsBody>,
  ) {
    return statusView(await this.google.updateSettings(actor, body));
  }

  @Post('sync')
  @ApiBearerAuth()
  @UseGuards(BearerAuthGuard)
  @RequireRoles('TEACHER')
  async sync(@CurrentActor() actor: Actor) {
    await this.google.requestSync(actor);
    return { requested: true };
  }

  @Delete()
  @ApiBearerAuth()
  @UseGuards(BearerAuthGuard)
  @RequireRoles('TEACHER')
  async disconnect(@CurrentActor() actor: Actor) {
    await this.google.disconnect(actor);
    return { disconnected: true };
  }
}
