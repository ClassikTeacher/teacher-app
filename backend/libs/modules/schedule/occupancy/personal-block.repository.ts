import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, isNull, lt } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import { type Interval, personalBlock, type PersonalBlockRow } from '../schema.js';

@Injectable()
export class PersonalBlockRepository {
  constructor(private readonly txm: TransactionManager) {}

  async insert(data: {
    teacherId: string;
    during: Interval;
    title: string | null;
  }): Promise<PersonalBlockRow> {
    const rows = await this.txm.db
      .insert(personalBlock)
      .values({
        id: newId(),
        teacherId: data.teacherId,
        startsAt: data.during.start,
        endsAt: data.during.end,
        title: data.title,
      })
      .returning();
    return rows[0]!;
  }

  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<PersonalBlockRow | null> {
    const query = this.txm.db.select().from(personalBlock).where(eq(personalBlock.id, id)).limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async remove(id: string, removedAt: Date): Promise<PersonalBlockRow | null> {
    const rows = await this.txm.db
      .update(personalBlock)
      .set({ removedAt })
      .where(and(eq(personalBlock.id, id), isNull(personalBlock.removedAt)))
      .returning();
    return rows[0] ?? null;
  }

  /** Active blocks of a teacher intersecting the range, in time order. */
  async listInRange(teacherId: string, range: Interval): Promise<PersonalBlockRow[]> {
    return this.txm.db
      .select()
      .from(personalBlock)
      .where(
        and(
          eq(personalBlock.teacherId, teacherId),
          isNull(personalBlock.removedAt),
          lt(personalBlock.startsAt, range.end),
          gt(personalBlock.endsAt, range.start),
        ),
      )
      .orderBy(asc(personalBlock.startsAt), asc(personalBlock.id));
  }
}
