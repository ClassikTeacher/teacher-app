import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { AuditService } from './audit.service.js';

describe('audit_log is append-only', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it('rejects updates and deletes even for the owner role', async () => {
    const audit = new AuditService(tdb.txm);
    await audit.record({ actorId: null, action: 'test', entityType: 'x', source: 'system' });
    // drizzle wraps driver errors ("Failed query: ...") and keeps the PostgreSQL error as `cause`
    const appendOnly = (e: unknown) =>
      /append-only/.test(String((e as { cause?: Error }).cause?.message ?? e));
    await expect(tdb.db.execute(sql`UPDATE audit_log SET action = 'tampered'`)).rejects.toSatisfy(appendOnly);
    await expect(tdb.db.execute(sql`DELETE FROM audit_log`)).rejects.toSatisfy(appendOnly);
  });
});
