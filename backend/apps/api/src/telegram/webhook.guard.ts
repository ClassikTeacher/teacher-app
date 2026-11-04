import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AppError } from '@shared/errors/app-error.js';
import { TelegramGateway } from '@telegram/gateway/telegram.gateway.js';

/** Runs before pipes: unauthenticated callers never see validation errors or bot names. */
@Injectable()
export class WebhookSecretGuard implements CanActivate {
  constructor(private readonly gateway: TelegramGateway) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers['x-telegram-bot-api-secret-token'];
    if (!this.gateway.isValidWebhookSecret(typeof header === 'string' ? header : undefined)) {
      throw new AppError('UNAUTHORIZED', 'Bad webhook secret');
    }
    return true;
  }
}
