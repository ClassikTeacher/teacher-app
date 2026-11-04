import { Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { boolean, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps } from '@shared/db/columns.js';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { account } from '@modules/identity/schema.js';

export const FILE_CATEGORIES = [
  'image',
  'document',
  'spreadsheet',
  'audio',
  'video',
  'archive',
  'other',
] as const;
export type FileCategory = (typeof FILE_CATEGORIES)[number];

/** Allowed upload types (5.10.3), maintained by admins (UC-44). */
export const fileType = pgTable('file_type', {
  ext: text('ext').primaryKey(),
  category: text('category', { enum: FILE_CATEGORIES }).notNull(),
  mime: text('mime').notNull(),
  isAllowed: boolean('is_allowed').notNull().default(true),
  position: integer('position').notNull().default(0),
  updatedBy: uuid('updated_by').references(() => account.id),
  ...timestamps(),
});

export type FileTypeRow = typeof fileType.$inferSelect;

@Injectable()
export class FileTypeRepository {
  constructor(private readonly txm: TransactionManager) {}

  async listAll(): Promise<FileTypeRow[]> {
    return this.txm.db.select().from(fileType).orderBy(asc(fileType.position), asc(fileType.ext));
  }

  async listAllowed(): Promise<FileTypeRow[]> {
    return this.txm.db
      .select()
      .from(fileType)
      .where(eq(fileType.isAllowed, true))
      .orderBy(asc(fileType.position));
  }

  async find(ext: string): Promise<FileTypeRow | null> {
    const rows = await this.txm.db.select().from(fileType).where(eq(fileType.ext, ext)).limit(1);
    return rows[0] ?? null;
  }

  async upsert(data: {
    ext: string;
    category: FileCategory;
    mime: string;
    isAllowed: boolean;
    updatedBy: string;
  }): Promise<FileTypeRow> {
    const rows = await this.txm.db
      .insert(fileType)
      .values({ ...data, position: 1000 })
      .onConflictDoUpdate({
        target: fileType.ext,
        set: {
          category: data.category,
          mime: data.mime,
          isAllowed: data.isAllowed,
          updatedBy: data.updatedBy,
        },
      })
      .returning();
    return rows[0]!;
  }

  async setAllowed(ext: string, isAllowed: boolean, updatedBy: string): Promise<FileTypeRow | null> {
    const rows = await this.txm.db
      .update(fileType)
      .set({ isAllowed, updatedBy })
      .where(eq(fileType.ext, ext))
      .returning();
    return rows[0] ?? null;
  }
}
