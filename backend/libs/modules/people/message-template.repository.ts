import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import { messageTemplate, type MessageTemplateRow, type TemplateKind } from './schema.js';

/** Teacher's reusable reason texts (5.7.2); archived rather than deleted. */
@Injectable()
export class MessageTemplateRepository {
  constructor(private readonly txm: TransactionManager) {}

  async listActive(ownerId: string, kind: TemplateKind): Promise<MessageTemplateRow[]> {
    return this.txm.db
      .select()
      .from(messageTemplate)
      .where(
        and(
          eq(messageTemplate.ownerId, ownerId),
          eq(messageTemplate.kind, kind),
          isNull(messageTemplate.archivedAt),
        ),
      )
      .orderBy(asc(messageTemplate.position), asc(messageTemplate.createdAt));
  }

  async findById(id: string): Promise<MessageTemplateRow | null> {
    const rows = await this.txm.db.select().from(messageTemplate).where(eq(messageTemplate.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async insert(data: {
    ownerId: string;
    kind: TemplateKind;
    text: string;
    position: number;
  }): Promise<MessageTemplateRow> {
    const rows = await this.txm.db
      .insert(messageTemplate)
      .values({ ...data, id: newId() })
      .returning();
    return rows[0]!;
  }

  async archive(id: string, now: Date): Promise<MessageTemplateRow | null> {
    const rows = await this.txm.db
      .update(messageTemplate)
      .set({ archivedAt: now })
      .where(and(eq(messageTemplate.id, id), isNull(messageTemplate.archivedAt)))
      .returning();
    return rows[0] ?? null;
  }
}
