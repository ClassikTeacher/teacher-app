import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import {
  type CancelAction,
  cancellation,
  cancellationItem,
  type CancellationItemRow,
  type CancellationKind,
  type CancellationRow,
  type CancelRole,
} from '../schema.js';

export interface NewCancellation {
  initiatorId: string | null;
  initiatorRole: CancelRole;
  onBehalfOfStudentId?: string | null;
  kind: CancellationKind;
  reason: string;
  templateId?: string | null;
  source?: string | null;
  createdAt: Date;
}

export interface NewCancellationItem {
  cancellationId: string;
  lessonId: string;
  action: CancelAction;
  studentId?: string | null;
  isLate: boolean;
  createdAt: Date;
}

/** Persistence of cancellation acts and their items (CNL-08). */
@Injectable()
export class CancellationRepository {
  constructor(private readonly txm: TransactionManager) {}

  async insert(data: NewCancellation): Promise<CancellationRow> {
    const rows = await this.txm.db
      .insert(cancellation)
      .values({ ...data, id: newId() })
      .returning();
    return rows[0]!;
  }

  async insertItems(items: readonly NewCancellationItem[]): Promise<CancellationItemRow[]> {
    if (items.length === 0) return [];
    return this.txm.db
      .insert(cancellationItem)
      .values(items.map((i) => ({ ...i, id: newId() })))
      .returning();
  }

  async findById(id: string): Promise<CancellationRow | null> {
    const rows = await this.txm.db.select().from(cancellation).where(eq(cancellation.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async listItems(cancellationId: string): Promise<CancellationItemRow[]> {
    return this.txm.db
      .select()
      .from(cancellationItem)
      .where(eq(cancellationItem.cancellationId, cancellationId));
  }

  /** The absence items of a lesson (who warned about not coming, CNL-03). */
  async absencesOf(lessonIds: readonly string[]): Promise<CancellationItemRow[]> {
    if (lessonIds.length === 0) return [];
    return this.txm.db
      .select()
      .from(cancellationItem)
      .where(and(inArray(cancellationItem.lessonId, [...lessonIds]), eq(cancellationItem.action, 'absence')));
  }

  /** The item that cancelled the lesson, if any. */
  async cancelItemOf(lessonId: string): Promise<CancellationItemRow | null> {
    const rows = await this.txm.db
      .select()
      .from(cancellationItem)
      .where(and(eq(cancellationItem.lessonId, lessonId), isNull(cancellationItem.studentId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** The cancelling items of several lessons together with their acts (who, late or not), for statistics (5.12). */
  async cancellationsOf(
    lessonIds: readonly string[],
  ): Promise<Array<{ item: CancellationItemRow; cancellation: CancellationRow }>> {
    if (lessonIds.length === 0) return [];
    const rows = await this.txm.db
      .select({ item: cancellationItem, cancellation })
      .from(cancellationItem)
      .innerJoin(cancellation, eq(cancellation.id, cancellationItem.cancellationId))
      .where(
        and(
          inArray(cancellationItem.lessonId, [...lessonIds]),
          eq(cancellationItem.action, 'cancelled'),
          isNull(cancellationItem.studentId),
        ),
      );
    return rows;
  }
}
