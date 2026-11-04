import { Injectable } from '@nestjs/common';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import { subject, type SubjectRow } from './schema.js';

/** Platform subject catalogue (Р-31). Ordered by admin position, then name (case-insensitive). */
@Injectable()
export class SubjectRepository {
  constructor(private readonly txm: TransactionManager) {}

  async listActive(): Promise<SubjectRow[]> {
    return this.txm.db
      .select()
      .from(subject)
      .where(eq(subject.isActive, true))
      .orderBy(asc(subject.position), sql`lower(${subject.name})`);
  }

  async listAll(): Promise<SubjectRow[]> {
    return this.txm.db
      .select()
      .from(subject)
      .orderBy(asc(subject.position), sql`lower(${subject.name})`);
  }

  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<SubjectRow | null> {
    const query = this.txm.db.select().from(subject).where(eq(subject.id, id)).limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async findByIds(ids: readonly string[]): Promise<SubjectRow[]> {
    if (ids.length === 0) return [];
    return this.txm.db
      .select()
      .from(subject)
      .where(inArray(subject.id, [...ids]));
  }

  async findByName(name: string): Promise<SubjectRow | null> {
    const rows = await this.txm.db
      .select()
      .from(subject)
      .where(sql`lower(${subject.name}) = lower(${name})`)
      .limit(1);
    return rows[0] ?? null;
  }

  /** Throws the raw unique violation (23505) on a case-insensitive duplicate; the use-case maps it. */
  async insert(data: { name: string; position?: number; createdBy: string | null }): Promise<SubjectRow> {
    const rows = await this.txm.db
      .insert(subject)
      .values({ id: newId(), name: data.name, position: data.position ?? 1000, createdBy: data.createdBy })
      .returning();
    return rows[0]!;
  }

  async update(
    id: string,
    patch: Partial<Pick<SubjectRow, 'name' | 'isActive' | 'position'>>,
  ): Promise<SubjectRow | null> {
    if (Object.keys(patch).length === 0) return this.findById(id);
    const rows = await this.txm.db.update(subject).set(patch).where(eq(subject.id, id)).returning();
    return rows[0] ?? null;
  }
}
