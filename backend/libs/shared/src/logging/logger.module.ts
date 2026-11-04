import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import type { Env } from '../config/env.schema.js';
import { ConfigModule, ENV } from '../config/config.module.js';
import { correlationMixin } from './correlation.js';

const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers["x-system-key"]',
  'req.headers["x-api-key"]',
  'req.headers["x-telegram-bot-api-secret-token"]',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

const HEALTH_PATHS = new Set(['/health', '/api/v1/health']);

/** Request id assigned by the Fastify adapter (see apps/api main.ts); raw Node requests carry it via this property. */
export const REQUEST_ID_PROPERTY = Symbol.for('tutor.requestId');

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          mixin: correlationMixin,
          redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
          // Reuse the id Fastify generated so logs, the ALS context and the x-correlation-id header agree.
          genReqId: (req) =>
            (req as unknown as Record<symbol, string | undefined>)[REQUEST_ID_PROPERTY] ??
            crypto.randomUUID(),
          autoLogging: { ignore: (req) => HEALTH_PATHS.has((req.url ?? '').split('?')[0] ?? '') },
          serializers: {
            // Query strings may carry tokens (deep links); log only the path.
            req: (req: { id: string; method: string; url: string; remoteAddress?: string }) => ({
              id: req.id,
              method: req.method,
              url: req.url.split('?')[0],
              remoteAddress: req.remoteAddress,
            }),
          },
          transport: env.LOG_PRETTY
            ? {
                target: 'pino-pretty',
                options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
              }
            : undefined,
        },
      }),
    }),
  ],
})
export class LoggerModule {}
