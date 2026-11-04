import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { createDb, createPool, type Db } from '../libs/shared/src/db/drizzle.js';
import { TransactionManager } from '../libs/shared/src/db/transaction-manager.js';

export interface TestDatabase {
  url: string;
  pool: pg.Pool;
  db: Db;
  txm: TransactionManager;
  drop(): Promise<void>;
}

const TEMPLATE_IN_USE = '55006';

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: inject('TEST_PG_ADMIN_URL') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A fresh database cloned from the migrated template: fast, isolated per test file. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `t_${randomBytes(6).toString('hex')}`;
  const template = inject('TEST_PG_TEMPLATE');
  for (let attempt = 1; ; attempt += 1) {
    try {
      await withAdmin((c) => c.query(`CREATE DATABASE ${name} TEMPLATE ${template}`));
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== TEMPLATE_IN_USE || attempt >= 20) throw error;
      await new Promise((r) => setTimeout(r, 100 * attempt));
    }
  }
  const url = inject('TEST_PG_ADMIN_URL').replace(/\/postgres$/, `/${name}`);
  const pool = createPool({ connectionString: url, max: 5, applicationName: `test-${name}` });
  const db = createDb(pool);
  return {
    url,
    pool,
    db,
    txm: new TransactionManager(db),
    drop: async () => {
      await pool.end();
      await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}
