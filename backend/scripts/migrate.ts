import { resolve } from 'node:path';
import { loadDotEnv, parseEnv } from '@shared/config/index.js';
import { createPool, runMigrations } from '@shared/db/index.js';

async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') loadDotEnv();
  const env = parseEnv(process.env);
  const pool = createPool({
    connectionString: env.DATABASE_URL,
    max: 1,
    applicationName: 'tutor-migrate',
    statementTimeoutMs: 10 * 60_000,
  });
  try {
    const result = await runMigrations(pool, resolve(process.cwd(), 'migrations'), (m) => console.log(m));
    console.log(`migrations: ${result.applied.length} applied, ${result.skipped.length} already applied`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
