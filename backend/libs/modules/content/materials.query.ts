import { Injectable } from '@nestjs/common';
import { AppError } from '@shared/errors/app-error.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import type { AccountRow } from '@modules/identity/schema.js';
import { FileRepository } from '@modules/files/file.repository.js';
import type { FileRow } from '@modules/files/schema.js';
import { GroupRepository } from '@modules/people/groups/group.repository.js';
import type { StudyGroupRow } from '@modules/people/schema.js';
import { GrantRepository } from './grant.repository.js';
import { MaterialRepository } from './material.repository.js';
import type { AccessGrantRow, CollectionRow, MaterialRow, MaterialViewRow } from './schema.js';

export interface GrantView {
  grant: AccessGrantRow;
  student: AccountRow | null;
  group: StudyGroupRow | null;
}

export interface MaterialCard {
  material: MaterialRow;
  file: FileRow | null;
  grants: GrantView[];
  views: MaterialViewRow[];
  collections: CollectionRow[];
}

export interface CollectionCard {
  collection: CollectionRow;
  materials: MaterialRow[];
  grants: GrantView[];
}

/** Read side for the teacher's screens and REST (ownership enforced by teacher_id, 8.0). */
@Injectable()
export class MaterialsQuery {
  constructor(
    private readonly materials: MaterialRepository,
    private readonly grants: GrantRepository,
    private readonly files: FileRepository,
    private readonly accounts: AccountRepository,
    private readonly groups: GroupRepository,
  ) {}

  async list(teacherId: string): Promise<MaterialRow[]> {
    return this.materials.listByTeacher(teacherId);
  }

  async collections(teacherId: string): Promise<CollectionRow[]> {
    return this.materials.listCollectionsByTeacher(teacherId);
  }

  async card(teacherId: string, materialId: string): Promise<MaterialCard> {
    const material = await this.materials.findById(materialId);
    if (!material || material.teacherId !== teacherId) throw AppError.notFound('material', materialId);
    const [file, grants, views, all] = await Promise.all([
      material.fileId ? this.files.findById(material.fileId) : null,
      this.grants.listBySubject('material', material.id),
      this.grants.listViews(material.id),
      this.materials.listCollectionsByTeacher(teacherId),
    ]);
    const items = await this.materials.listItemsOf(all.map((c) => c.id));
    const inIds = new Set(
      items.filter((i) => i.itemType === 'material' && i.itemId === material.id).map((i) => i.collectionId),
    );
    return {
      material,
      file,
      grants: await this.hydrate(grants),
      views,
      collections: all.filter((c) => inIds.has(c.id)),
    };
  }

  async collectionCard(teacherId: string, collectionId: string): Promise<CollectionCard> {
    const collection = await this.materials.findCollection(collectionId);
    if (!collection || collection.teacherId !== teacherId)
      throw AppError.notFound('collection', collectionId);
    const items = await this.materials.listItems(collection.id);
    const byId = new Map(
      (
        await this.materials.findByIds(items.filter((i) => i.itemType === 'material').map((i) => i.itemId))
      ).map((m) => [m.id, m]),
    );
    const materials = items.flatMap((i) => (byId.has(i.itemId) ? [byId.get(i.itemId)!] : []));
    return {
      collection,
      materials,
      grants: await this.hydrate(await this.grants.listBySubject('collection', collection.id)),
    };
  }

  private async hydrate(grants: AccessGrantRow[]): Promise<GrantView[]> {
    const studentIds = grants.filter((g) => g.granteeType === 'student').map((g) => g.granteeId);
    const groupIds = grants.filter((g) => g.granteeType === 'group').map((g) => g.granteeId);
    const [students, groups] = await Promise.all([
      this.accounts.findByIds(studentIds),
      Promise.all(groupIds.map((id) => this.groups.findById(id))),
    ]);
    const studentById = new Map(students.map((s) => [s.id, s]));
    const groupById = new Map(groups.flatMap((g) => (g ? [[g.id, g] as const] : [])));
    return grants.map((grant) => ({
      grant,
      student: grant.granteeType === 'student' ? (studentById.get(grant.granteeId) ?? null) : null,
      group: grant.granteeType === 'group' ? (groupById.get(grant.granteeId) ?? null) : null,
    }));
  }
}
