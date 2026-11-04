import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import type pg from 'pg';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import { createDb, createPool, DB, PG_POOL } from './drizzle.js';
import { TransactionManager } from './transaction-manager.js';

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ENV],
      useFactory: (env: Env): pg.Pool =>
        createPool({
          connectionString: env.DATABASE_URL,
          onError: (error) => new Logger('PgPool').error({ err: error }, 'idle PostgreSQL client error'),
        }),
    },
    { provide: DB, inject: [PG_POOL], useFactory: (pool: pg.Pool) => createDb(pool) },
    TransactionManager,
  ],
  exports: [PG_POOL, DB, TransactionManager],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
