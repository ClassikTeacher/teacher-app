import { Injectable } from '@nestjs/common';
import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import {
  availabilityException,
  type AvailabilityExceptionRow,
  availabilityRule,
  type AvailabilityRuleRow,
  type ExceptionKind,
} from '../schema.js';

export interface NewRule {
  teacherId: string;
  weekday: number;
  startLocal: string;
  endLocal: string;
  validFrom: string | null;
  validTo: string | null;
}

export interface NewException {
  teacherId: string;
  date: string;
  kind: ExceptionKind;
  startLocal: string | null;
  endLocal: string | null;
}

/** Persistence for weekly windows and date exceptions (5.5.4). Rows are soft-removed. */
@Injectable()
export class AvailabilityRepository {
  constructor(private readonly txm: TransactionManager) {}

  async insertRules(rows: readonly NewRule[]): Promise<AvailabilityRuleRow[]> {
    if (rows.length === 0) return [];
    return this.txm.db
      .insert(availabilityRule)
      .values(rows.map((r) => ({ ...r, id: newId() })))
      .returning();
  }

  async listRules(teacherId: string): Promise<AvailabilityRuleRow[]> {
    return this.txm.db
      .select()
      .from(availabilityRule)
      .where(and(eq(availabilityRule.teacherId, teacherId), isNull(availabilityRule.removedAt)))
      .orderBy(asc(availabilityRule.weekday), asc(availabilityRule.startLocal), asc(availabilityRule.id));
  }

  async findRule(id: string): Promise<AvailabilityRuleRow | null> {
    const rows = await this.txm.db
      .select()
      .from(availabilityRule)
      .where(eq(availabilityRule.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async removeRule(id: string, removedAt: Date): Promise<boolean> {
    const rows = await this.txm.db
      .update(availabilityRule)
      .set({ removedAt })
      .where(and(eq(availabilityRule.id, id), isNull(availabilityRule.removedAt)))
      .returning({ id: availabilityRule.id });
    return rows.length > 0;
  }

  async insertException(row: NewException): Promise<AvailabilityExceptionRow> {
    const rows = await this.txm.db
      .insert(availabilityException)
      .values({ ...row, id: newId() })
      .returning();
    return rows[0]!;
  }

  /** Exceptions with a date in `[fromIso, toIso]` (teacher-local dates). */
  async listExceptions(
    teacherId: string,
    fromIso: string,
    toIso: string,
  ): Promise<AvailabilityExceptionRow[]> {
    return this.txm.db
      .select()
      .from(availabilityException)
      .where(
        and(
          eq(availabilityException.teacherId, teacherId),
          isNull(availabilityException.removedAt),
          gte(availabilityException.date, fromIso),
          lte(availabilityException.date, toIso),
        ),
      )
      .orderBy(
        asc(availabilityException.date),
        asc(availabilityException.startLocal),
        asc(availabilityException.id),
      );
  }

  async findException(id: string): Promise<AvailabilityExceptionRow | null> {
    const rows = await this.txm.db
      .select()
      .from(availabilityException)
      .where(eq(availabilityException.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async removeException(id: string, removedAt: Date): Promise<boolean> {
    const rows = await this.txm.db
      .update(availabilityException)
      .set({ removedAt })
      .where(and(eq(availabilityException.id, id), isNull(availabilityException.removedAt)))
      .returning({ id: availabilityException.id });
    return rows.length > 0;
  }
}
