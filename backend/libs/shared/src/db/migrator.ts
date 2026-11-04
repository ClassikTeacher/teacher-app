import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';

const LOCK_KEY = 7_272_001;
const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

interface AppliedRow {
  name: string;
  checksum: string | null;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function listMigrations(files: string[]): string[] {
  const sorted = files.filter((f) => MIGRATION_FILE.test(f)).sort();
  const seen = new Map<string, string>();
  for (const file of sorted) {
    const prefix = MIGRATION_FILE.exec(file)![1]!;
    const duplicate = seen.get(prefix);
    if (duplicate) throw new Error(`Duplicate migration number ${prefix}: ${duplicate} and ${file}`);
    seen.set(prefix, file);
  }
  return sorted;
}

/**
 * Applies `NNNN_name.sql` files from `dir` in lexical order, each inside its own transaction,
 * recording name and checksum in `schema_migration`. Guards: a session-level advisory lock serialises
 * concurrent runs; an edited applied file or an unapplied file older than an applied one aborts the run.
 */
export async function runMigrations(
  pool: pg.Pool,
  dir: string,
  log: (message: string) => void = () => undefined,
): Promise<MigrationResult> {
  const files = listMigrations(await readdir(dir));
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  let broken = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migration (
         name text PRIMARY KEY,
         checksum text,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    // Older runners created the table without checksums; keep the upgrade path transparent.
    await client.query('ALTER TABLE schema_migration ADD COLUMN IF NOT EXISTS checksum text');
    const appliedRows = await client.query<AppliedRow>('SELECT name, checksum FROM schema_migration');
    const applied = new Map(appliedRows.rows.map((r) => [r.name, r.checksum]));
    const lastApplied = [...applied.keys()].sort().at(-1);

    for (const file of files) {
      const sql = await readFile(join(dir, file), 'utf8');
      const checksum = sha256(sql);
      if (applied.has(file)) {
        const recorded = applied.get(file);
        if (recorded && recorded !== checksum) {
          throw new Error(`Migration ${file} was modified after being applied (checksum mismatch)`);
        }
        result.skipped.push(file);
        continue;
      }
      if (lastApplied && file < lastApplied) {
        throw new Error(`Migration ${file} sorts before already applied ${lastApplied}; renumber it`);
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migration (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {
          broken = true;
        });
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration ${file} failed: ${reason}`, { cause: error });
      }
      result.applied.push(file);
      log(`applied ${file}`);
    }
  } finally {
    if (!broken) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release(broken);
  }
  return result;
}
