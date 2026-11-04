import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export type Db = NodePgDatabase<Record<string, never>>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Either the root database or the transaction bound to the current async context. */
export type DbClient = Db | Tx;

export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');

export interface PoolOptions {
  connectionString: string;
  max?: number;
  applicationName?: string;
  /** Receives background errors of idle clients (e.g. the server restarted); without it Node would crash. */
  onError?: (error: Error) => void;
  /** Per-statement timeout; migrations pass a larger value. */
  statementTimeoutMs?: number;
}

export function createPool(options: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'tutor-platform',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: options.statementTimeoutMs ?? 30_000,
    idle_in_transaction_session_timeout: 60_000,
  });
  pool.on('error', options.onError ?? (() => undefined));
  return pool;
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool);
}

/** PostgreSQL SQLSTATE codes the domain layer reacts to. */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_EXCLUSION_VIOLATION = '23P01';

export function pgErrorCode(error: unknown): string | undefined {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = candidate?.code ?? candidate?.cause?.code;
  return typeof code === 'string' ? code : undefined;
}
