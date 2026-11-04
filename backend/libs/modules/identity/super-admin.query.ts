import { and, eq, isNull } from 'drizzle-orm';
import type { DbClient } from '@shared/db/drizzle.js';
import { accountRole } from './schema.js';

/** The single active super admin (3.2), if seeded. */
export async function superAdminAccountId(db: DbClient): Promise<string | null> {
  const rows = await db
    .select({ accountId: accountRole.accountId })
    .from(accountRole)
    .where(and(eq(accountRole.role, 'SUPER_ADMIN'), isNull(accountRole.revokedAt)))
    .limit(1);
  return rows[0]?.accountId ?? null;
}
