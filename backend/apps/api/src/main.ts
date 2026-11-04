import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { loadDotEnv, parseEnv } from '@shared/config/index.js';
import { AppErrorFilter, EnvelopeInterceptor } from '@shared/http/index.js';
import { REQUEST_ID_PROPERTY, runWithCorrelation } from '@shared/logging/index.js';
import { ApiModule } from './api.module.js';

const CORRELATION_ID = /^[A-Za-z0-9._-]{1,128}$/;

async function bootstrap(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') loadDotEnv();
  const env = parseEnv(process.env);

  const adapter = new FastifyAdapter({
    // Accept a client-provided id only when it is well-formed; otherwise mint our own.
    genReqId: (req: IncomingMessage) => {
      const header = req.headers['x-correlation-id'];
      const id = typeof header === 'string' && CORRELATION_ID.test(header) ? header : randomUUID();
      (req as unknown as Record<symbol, string>)[REQUEST_ID_PROPERTY] = id;
      return id;
    },
    // Fastify: `false` trusts nothing; a number trusts that many proxy hops.
    trustProxy: env.TRUST_PROXY_HOPS === 0 ? false : (env.TRUST_PROXY_HOPS as unknown as boolean),
    bodyLimit: 1024 * 1024,
  });
  const fastify = adapter.getInstance();
  // Correlation context for everything below the HTTP layer (use-cases, outbox, logs).
  fastify.addHook('onRequest', (request, _reply, done) => {
    runWithCorrelation(() => done(), { correlationId: request.id });
  });
  fastify.addHook('onSend', (request, reply, _payload, done) => {
    reply.header('x-correlation-id', request.id);
    done();
  });

  const app = await NestFactory.create<NestFastifyApplication>(ApiModule, adapter, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.flushLogs();
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.useGlobalInterceptors(new EnvelopeInterceptor());
  app.useGlobalFilters(new AppErrorFilter());
  app.enableShutdownHooks();

  if (env.SWAGGER_ENABLED ?? env.NODE_ENV !== 'production') {
    const openapi = new DocumentBuilder()
      .setTitle('Tutor Platform API')
      .setVersion('0.1')
      .addBearerAuth()
      .addApiKey({ type: 'apiKey', in: 'header', name: 'X-System-Key' }, 'system-key')
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, openapi));
  }

  await app.listen({ port: env.API_PORT, host: env.API_HOST });
}

bootstrap().catch((error: unknown) => {
  console.error('API failed to start', error);
  process.exit(1);
});
