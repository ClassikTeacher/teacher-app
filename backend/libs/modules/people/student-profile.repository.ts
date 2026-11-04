import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { studentProfile, type StudentProfileRow } from './schema.js';

export type StudentProfilePatch = Partial<Pick<StudentProfileRow, 'school' | 'grade' | 'onboardedAt'>>;

@Injectable()
export class StudentProfileRepository {
  constructor(private readonly txm: TransactionManager) {}

  async find(accountId: string): Promise<StudentProfileRow | null> {
    const rows = await this.txm.db
      .select()
      .from(studentProfile)
      .where(eq(studentProfile.accountId, accountId))
      .limit(1);
    return rows[0] ?? null;
  }

  async upsert(accountId: string, patch: StudentProfilePatch): Promise<StudentProfileRow> {
    const rows = await this.txm.db
      .insert(studentProfile)
      .values({ accountId, ...patch })
      .onConflictDoUpdate({ target: studentProfile.accountId, set: patch })
      .returning();
    return rows[0]!;
  }
}
