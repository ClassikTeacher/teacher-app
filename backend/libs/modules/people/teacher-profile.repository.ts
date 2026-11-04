import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { teacherProfile, type TeacherProfileInsert, type TeacherProfileRow } from './schema.js';

export type TeacherProfilePatch = Partial<
  Omit<TeacherProfileInsert, 'accountId' | 'createdAt' | 'updatedAt'>
>;

@Injectable()
export class TeacherProfileRepository {
  constructor(private readonly txm: TransactionManager) {}

  async find(accountId: string, options: { forUpdate?: boolean } = {}): Promise<TeacherProfileRow | null> {
    const query = this.txm.db
      .select()
      .from(teacherProfile)
      .where(eq(teacherProfile.accountId, accountId))
      .limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async upsert(accountId: string, patch: TeacherProfilePatch): Promise<TeacherProfileRow> {
    const rows = await this.txm.db
      .insert(teacherProfile)
      .values({ accountId, ...patch })
      .onConflictDoUpdate({ target: teacherProfile.accountId, set: patch })
      .returning();
    return rows[0]!;
  }
}
