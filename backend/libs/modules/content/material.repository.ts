import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import {
  collection,
  type CollectionInsert,
  collectionItem,
  type CollectionItemRow,
  type CollectionItemType,
  type CollectionRow,
  lessonMaterial,
  type LessonMaterialRow,
  material,
  type MaterialInsert,
  type MaterialRow,
  type Release,
} from './schema.js';

export type NewMaterial = Omit<MaterialInsert, 'id' | 'createdAt' | 'updatedAt'>;
export type MaterialPatch = Partial<
  Pick<MaterialInsert, 'title' | 'description' | 'subjectId' | 'tags' | 'archivedAt'>
>;
export type NewCollection = Omit<CollectionInsert, 'id' | 'createdAt' | 'updatedAt'>;

/** Persistence for materials, collections, their items and lesson attachments (5.9). No rules here. */
@Injectable()
export class MaterialRepository {
  constructor(private readonly txm: TransactionManager) {}

  async insert(data: NewMaterial): Promise<MaterialRow> {
    const rows = await this.txm.db
      .insert(material)
      .values({ ...data, id: newId() })
      .returning();
    return rows[0]!;
  }

  async findById(id: string): Promise<MaterialRow | null> {
    const rows = await this.txm.db.select().from(material).where(eq(material.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async findByIds(ids: readonly string[]): Promise<MaterialRow[]> {
    if (ids.length === 0) return [];
    return this.txm.db
      .select()
      .from(material)
      .where(inArray(material.id, [...ids]))
      .orderBy(desc(material.createdAt));
  }

  async update(id: string, patch: MaterialPatch): Promise<MaterialRow> {
    const rows = await this.txm.db.update(material).set(patch).where(eq(material.id, id)).returning();
    const row = rows[0];
    if (!row) throw new Error(`material ${id} not found`);
    return row;
  }

  /** The teacher's library, newest first (archived ones excluded unless asked). */
  async listByTeacher(teacherId: string, options: { archived?: boolean } = {}): Promise<MaterialRow[]> {
    return this.txm.db
      .select()
      .from(material)
      .where(
        and(
          eq(material.teacherId, teacherId),
          options.archived ? sql`${material.archivedAt} IS NOT NULL` : isNull(material.archivedAt),
        ),
      )
      .orderBy(desc(material.createdAt), desc(material.id));
  }

  async countByTeacher(teacherId: string): Promise<number> {
    const rows = await this.txm.db
      .select({ n: sql<number>`count(*)::int` })
      .from(material)
      .where(and(eq(material.teacherId, teacherId), isNull(material.archivedAt)));
    return rows[0]?.n ?? 0;
  }

  // --- collections -------------------------------------------------------------------------------

  async insertCollection(data: NewCollection): Promise<CollectionRow> {
    const rows = await this.txm.db
      .insert(collection)
      .values({ ...data, id: newId() })
      .returning();
    return rows[0]!;
  }

  async findCollection(id: string): Promise<CollectionRow | null> {
    const rows = await this.txm.db.select().from(collection).where(eq(collection.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async findCollections(ids: readonly string[]): Promise<CollectionRow[]> {
    if (ids.length === 0) return [];
    return this.txm.db
      .select()
      .from(collection)
      .where(inArray(collection.id, [...ids]))
      .orderBy(asc(collection.title));
  }

  async listCollectionsByTeacher(teacherId: string): Promise<CollectionRow[]> {
    return this.txm.db
      .select()
      .from(collection)
      .where(and(eq(collection.teacherId, teacherId), isNull(collection.archivedAt)))
      .orderBy(asc(collection.title), asc(collection.id));
  }

  async updateCollection(
    id: string,
    patch: Partial<
      Pick<CollectionInsert, 'title' | 'description' | 'periodFrom' | 'periodTo' | 'archivedAt'>
    >,
  ): Promise<CollectionRow> {
    const rows = await this.txm.db.update(collection).set(patch).where(eq(collection.id, id)).returning();
    const row = rows[0];
    if (!row) throw new Error(`collection ${id} not found`);
    return row;
  }

  /** Appends at the end; an item already in the collection is left where it is. */
  async addItem(
    collectionId: string,
    itemType: CollectionItemType,
    itemId: string,
  ): Promise<CollectionItemRow> {
    const last = await this.txm.db
      .select({ position: sql<number>`coalesce(max(${collectionItem.position}), 0)::int` })
      .from(collectionItem)
      .where(eq(collectionItem.collectionId, collectionId));
    const rows = await this.txm.db
      .insert(collectionItem)
      .values({ id: newId(), collectionId, itemType, itemId, position: (last[0]?.position ?? 0) + 1 })
      .onConflictDoNothing()
      .returning();
    return rows[0] ?? (await this.listItems(collectionId)).find((i) => i.itemId === itemId)!;
  }

  async removeItem(collectionId: string, itemType: CollectionItemType, itemId: string): Promise<void> {
    await this.txm.db
      .delete(collectionItem)
      .where(
        and(
          eq(collectionItem.collectionId, collectionId),
          eq(collectionItem.itemType, itemType),
          eq(collectionItem.itemId, itemId),
        ),
      );
  }

  async listItems(collectionId: string): Promise<CollectionItemRow[]> {
    return this.txm.db
      .select()
      .from(collectionItem)
      .where(eq(collectionItem.collectionId, collectionId))
      .orderBy(asc(collectionItem.position), asc(collectionItem.createdAt));
  }

  async listItemsOf(collectionIds: readonly string[]): Promise<CollectionItemRow[]> {
    if (collectionIds.length === 0) return [];
    return this.txm.db
      .select()
      .from(collectionItem)
      .where(inArray(collectionItem.collectionId, [...collectionIds]))
      .orderBy(asc(collectionItem.position));
  }

  // --- lesson materials --------------------------------------------------------------------------

  async attachToLesson(
    lessonId: string,
    target: { materialId: string } | { collectionId: string },
    release: Release,
  ): Promise<LessonMaterialRow> {
    const rows = await this.txm.db
      .insert(lessonMaterial)
      .values({
        id: newId(),
        lessonId,
        materialId: 'materialId' in target ? target.materialId : null,
        collectionId: 'collectionId' in target ? target.collectionId : null,
        release,
      })
      .returning();
    return rows[0]!;
  }

  async listLessonMaterials(lessonId: string): Promise<LessonMaterialRow[]> {
    return this.txm.db
      .select()
      .from(lessonMaterial)
      .where(eq(lessonMaterial.lessonId, lessonId))
      .orderBy(asc(lessonMaterial.createdAt));
  }

  async detachFromLesson(id: string): Promise<void> {
    await this.txm.db.delete(lessonMaterial).where(eq(lessonMaterial.id, id));
  }
}
