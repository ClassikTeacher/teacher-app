import { type DynamicModule, Global, Module } from '@nestjs/common';
import { type Env, parseEnv } from './env.schema.js';

export const ENV = Symbol('ENV');

/**
 * Validates environment once per process. Consumers inject the typed `Env` via `@Inject(ENV)`.
 * `.env` files are read by the entry point (`loadDotEnv`), not here, so tests can inject their own env.
 */
@Global()
@Module({
  providers: [{ provide: ENV, useFactory: (): Env => parseEnv(process.env) }],
  exports: [ENV],
})
export class ConfigModule {
  static withEnv(env: Env): DynamicModule {
    return {
      module: ConfigModule,
      global: true,
      providers: [{ provide: ENV, useValue: env }],
      exports: [ENV],
    };
  }
}
