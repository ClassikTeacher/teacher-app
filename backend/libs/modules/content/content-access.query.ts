import { Injectable } from '@nestjs/common';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { FeatureService } from '@modules/access/features/feature.service.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import type { AccountRow } from '@modules/identity/schema.js';
import { GroupRepository } from '@modules/people/groups/group.repository.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { GrantRepository } from './grant.repository.js';
import { MaterialRepository } from './material.repository.js';
import type { AccessGrantRow, CollectionRow, MaterialRow } from './schema.js';

export interface VisibleCollection {
  collection: CollectionRow;
  materials: MaterialRow[];
}

export interface StudentLibrary {
  teacher: AccountRow;
  collections: VisibleCollection[];
  /** Materials granted on their own (not through a collection), newest first. */
  materials: MaterialRow[];
  viewed: Set<string>;
}

/** Is the grant open at `now` (delayed opening, optional end)? */
export function isGrantOpen(
  g: Pick<AccessGrantRow, 'availableFrom' | 'availableUntil' | 'revokedAt'>,
  now: Date,
): boolean {
  if (g.revokedAt) return false;
  if (g.availableFrom && g.availableFrom.getTime() > now.getTime()) return false;
  if (g.availableUntil && g.availableUntil.getTime() <= now.getTime()) return false;
  return true;
}

/**
 * MAT-01: what a student may see, computed from live grants at every call — direct ones and those of the
 * groups the student is a member of right now — only while the link with the teacher is active and the
 * teacher's `materials` feature is on (5.3.3).
 */
@Injectable()
export class ContentAccessQuery {
  constructor(
    private readonly grants: GrantRepository,
    private readonly materials: MaterialRepository,
    private readonly links: TeacherStudentRepository,
    private readonly groups: GroupRepository,
    private readonly accounts: AccountRepository,
    private readonly features: FeatureService,
    private readonly clock: Clock,
  ) {}

  /** Teachers who have handed anything to the student (StudentBot → Материалы, step 1). */
  async teachersFor(studentId: string): Promise<AccountRow[]> {
    const grants = await this.openGrants(studentId);
    const teacherIds = [...new Set(grants.map((g) => g.teacherId))];
    return this.accounts.findByIds(teacherIds);
  }

  async libraryFor(studentId: string, teacherId: string): Promise<StudentLibrary> {
    const teacher = await this.accounts.findById(teacherId);
    if (!teacher) throw AppError.notFound('account', teacherId);
    const grants = (await this.openGrants(studentId, teacherId)).filter(
      (g) => g.subjectType !== 'assignment',
    );
    const collectionIds = [
      ...new Set(grants.filter((g) => g.subjectType === 'collection').map((g) => g.subjectId)),
    ];
    const directIds = [
      ...new Set(grants.filter((g) => g.subjectType === 'material').map((g) => g.subjectId)),
    ];
    const [collections, items] = await Promise.all([
      this.materials.findCollections(collectionIds),
      this.materials.listItemsOf(collectionIds),
    ]);
    const live = (rows: MaterialRow[]) => rows.filter((m) => !m.archivedAt);
    const allMaterialIds = [
      ...new Set([...directIds, ...items.filter((i) => i.itemType === 'material').map((i) => i.itemId)]),
    ];
    const byId = new Map(live(await this.materials.findByIds(allMaterialIds)).map((m) => [m.id, m]));
    const visible: VisibleCollection[] = collections
      .filter((c) => !c.archivedAt)
      .map((c) => ({
        collection: c,
        materials: items
          .filter((i) => i.collectionId === c.id && i.itemType === 'material')
          .flatMap((i) => (byId.has(i.itemId) ? [byId.get(i.itemId)!] : [])),
      }));
    const materials = directIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    return {
      teacher,
      collections: visible,
      materials,
      viewed: await this.grants.viewedBy(studentId, [...byId.keys()]),
    };
  }

  /** MAT-01: checked at every access; null when the student may not see the material right now. */
  async materialFor(studentId: string, materialId: string): Promise<MaterialRow | null> {
    const row = await this.materials.findById(materialId);
    if (!row || row.archivedAt) return null;
    const grants = await this.openGrants(studentId, row.teacherId);
    if (grants.some((g) => g.subjectType === 'material' && g.subjectId === row.id)) return row;
    const collectionIds = await this.liveCollectionIds(grants);
    const items = await this.materials.listItemsOf(collectionIds);
    return items.some((i) => i.itemType === 'material' && i.itemId === row.id) ? row : null;
  }

  /** One collection with its visible materials, or null (StudentBot → подборка, notification button). */
  async collectionFor(studentId: string, collectionId: string): Promise<VisibleCollection | null> {
    const col = await this.materials.findCollection(collectionId);
    if (!col || col.archivedAt) return null;
    const grants = await this.openGrants(studentId, col.teacherId);
    if (!grants.some((g) => g.subjectType === 'collection' && g.subjectId === col.id)) return null;
    const items = (await this.materials.listItems(col.id)).filter((i) => i.itemType === 'material');
    const materials = (await this.materials.findByIds(items.map((i) => i.itemId))).filter(
      (m) => !m.archivedAt,
    );
    const byId = new Map(materials.map((m) => [m.id, m]));
    return {
      collection: col,
      materials: items.flatMap((i) => (byId.has(i.itemId) ? [byId.get(i.itemId)!] : [])),
    };
  }

  /** Granted collections that still exist (archived ones hide their materials, MAT-02). */
  private async liveCollectionIds(grants: readonly AccessGrantRow[]): Promise<string[]> {
    const ids = [...new Set(grants.filter((g) => g.subjectType === 'collection').map((g) => g.subjectId))];
    return (await this.materials.findCollections(ids)).filter((c) => !c.archivedAt).map((c) => c.id);
  }

  async viewedBy(studentId: string, materialIds: readonly string[]): Promise<Set<string>> {
    return this.grants.viewedBy(studentId, materialIds);
  }

  async markViewed(studentId: string, materialId: string): Promise<void> {
    await this.grants.markViewed(materialId, studentId, this.clock.now());
  }

  /** Live, open grants reaching the student (optionally of one teacher), gated by link and feature. */
  async openGrants(studentId: string, teacherId?: string): Promise<AccessGrantRow[]> {
    const now = this.clock.now();
    const groupIds = (await this.groups.listActiveMembershipsOfStudent(studentId)).map((m) => m.groupId);
    const grants = (await this.grants.listForStudent(studentId, groupIds, teacherId)).filter((g) =>
      isGrantOpen(g, now),
    );
    const teacherIds = [...new Set(grants.map((g) => g.teacherId))];
    const allowed = new Set<string>();
    for (const id of teacherIds) {
      const link = await this.links.findByPair(id, studentId);
      if (link?.status === 'active' && (await this.features.isEnabled(id, 'materials'))) allowed.add(id);
    }
    return grants.filter((g) => allowed.has(g.teacherId));
  }
}
