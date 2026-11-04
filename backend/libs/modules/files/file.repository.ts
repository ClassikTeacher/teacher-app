import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import type { Bot } from '@modules/identity/schema.js';
import {
  file,
  type FileInsert,
  type FileRow,
  type ScanStatus,
  storageUsage,
  telegramFileCache,
  type TelegramFileCacheRow,
} from './schema.js';

/** `createdAt` comes from the application clock, so the 24 h draft rule is testable and clock-consistent. */
export type NewFile = Omit<FileInsert, 'id' | 'updatedAt'>;

/** Persistence for file rows, the per-bot `file_id` cache and the teacher's storage counter. No rules here. */
@Injectable()
export class FileRepository {
  constructor(private readonly txm: TransactionManager) {}

  async insert(data: NewFile): Promise<FileRow> {
    const rows = await this.txm.db
      .insert(file)
      .values({ ...data, id: newId() })
      .returning();
    return rows[0]!;
  }

  async findById(id: string): Promise<FileRow | null> {
    const rows = await this.txm.db.select().from(file).where(eq(file.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async lockById(id: string): Promise<FileRow | null> {
    const rows = await this.txm.db.select().from(file).where(eq(file.id, id)).limit(1).for('update');
    return rows[0] ?? null;
  }

  async findByIds(ids: readonly string[]): Promise<FileRow[]> {
    if (ids.length === 0) return [];
    return this.txm.db
      .select()
      .from(file)
      .where(inArray(file.id, [...ids]))
      .orderBy(asc(file.createdAt), asc(file.id));
  }

  async update(id: string, patch: Partial<Omit<FileInsert, 'id'>>): Promise<FileRow> {
    const rows = await this.txm.db.update(file).set(patch).where(eq(file.id, id)).returning();
    const row = rows[0];
    if (!row) throw new Error(`file ${id} not found`);
    return row;
  }

  /**
   * Draft files mark the content they belong to; the GC leaves them alone from then on. Returns the ids that
   * were still drafts of `ownerTeacherId`: callers compare with what they asked for (a purged or foreign id is
   * missing) and refuse the operation.
   */
  async markAttached(
    ids: readonly string[],
    ownerTeacherId: string,
    at: Date,
    options: { uploadedBy?: string } = {},
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.txm.db
      .update(file)
      .set({ status: 'attached', attachedAt: at })
      .where(
        and(
          inArray(file.id, [...ids]),
          eq(file.status, 'draft'),
          eq(file.ownerTeacherId, ownerTeacherId),
          options.uploadedBy ? eq(file.uploadedBy, options.uploadedBy) : undefined,
        ),
      )
      .returning({ id: file.id });
    return rows.map((r) => r.id);
  }

  async listDraftsOlderThan(before: Date, limit: number): Promise<FileRow[]> {
    return this.txm.db
      .select()
      .from(file)
      .where(and(eq(file.status, 'draft'), lt(file.createdAt, before)))
      .orderBy(asc(file.createdAt))
      .limit(limit);
  }

  async listPendingScan(limit: number): Promise<FileRow[]> {
    return this.txm.db
      .select()
      .from(file)
      .where(and(eq(file.scanStatus, 'pending'), sql`${file.status} <> 'deleted'`))
      .orderBy(asc(file.createdAt))
      .limit(limit);
  }

  async setScan(id: string, scanStatus: ScanStatus, scanError: string | null = null): Promise<FileRow> {
    return this.update(id, { scanStatus, scanError });
  }

  async findCache(fileId: string, bot: Bot): Promise<TelegramFileCacheRow | null> {
    const rows = await this.txm.db
      .select()
      .from(telegramFileCache)
      .where(and(eq(telegramFileCache.fileId, fileId), eq(telegramFileCache.bot, bot)))
      .limit(1);
    return rows[0] ?? null;
  }

  async putCache(fileId: string, bot: Bot, telegramFileId: string, uniqueId: string): Promise<void> {
    await this.txm.db
      .insert(telegramFileCache)
      .values({ id: newId(), fileId, bot, telegramFileId, telegramFileUniqueId: uniqueId })
      .onConflictDoUpdate({
        target: [telegramFileCache.fileId, telegramFileCache.bot],
        set: { telegramFileId, telegramFileUniqueId: uniqueId },
      });
  }

  async dropCache(fileId: string, bot: Bot): Promise<void> {
    await this.txm.db
      .delete(telegramFileCache)
      .where(and(eq(telegramFileCache.fileId, fileId), eq(telegramFileCache.bot, bot)));
  }

  async usedBytes(teacherId: string): Promise<number> {
    const rows = await this.txm.db
      .select({ used: storageUsage.usedBytes })
      .from(storageUsage)
      .where(eq(storageUsage.teacherId, teacherId))
      .limit(1);
    return rows[0]?.used ?? 0;
  }

  /**
   * Charges `bytes` to the teacher if the result stays within `quota` (null = unlimited). Atomic: the conditional
   * UPDATE is the check, so two concurrent uploads cannot both squeeze past the limit (Р-27).
   */
  async reserve(teacherId: string, bytes: number, quota: number | null): Promise<boolean> {
    await this.txm.db.insert(storageUsage).values({ teacherId }).onConflictDoNothing();
    const rows = await this.txm.db
      .update(storageUsage)
      .set({ usedBytes: sql`${storageUsage.usedBytes} + ${bytes}`, updatedAt: sql`now()` })
      .where(
        and(
          eq(storageUsage.teacherId, teacherId),
          quota === null ? undefined : sql`${storageUsage.usedBytes} + ${bytes} <= ${quota}`,
        ),
      )
      .returning({ used: storageUsage.usedBytes });
    return rows.length > 0;
  }

  async release(teacherId: string, bytes: number): Promise<void> {
    await this.txm.db
      .update(storageUsage)
      .set({ usedBytes: sql`GREATEST(${storageUsage.usedBytes} - ${bytes}, 0)`, updatedAt: sql`now()` })
      .where(eq(storageUsage.teacherId, teacherId));
  }
}
