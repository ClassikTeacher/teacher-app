import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { loadDotEnv } from '@shared/config/index.js';
import { WorkerModule } from './worker.module.js';

async function bootstrap(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') loadDotEnv();
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.init();
  app.get(Logger).log('Worker started');
  await new Promise<void>((resolve) => {
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
  });
  await app.close();
}

bootstrap().catch((error: unknown) => {
  console.error('Worker failed to start', error);
  process.exit(1);
});
