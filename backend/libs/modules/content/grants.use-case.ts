import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { type Actor, assertRole } from '@modules/access/actor.js';
import { FeatureService } from '@modules/access/features/feature.service.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { GroupRepository } from '@modules/people/groups/group.repository.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { GrantRepository } from './grant.repository.js';
import { MaterialRepository } from './material.repository.js';
import type { AccessGrantRow, GrantSubjectType } from './schema.js';

export type Grantee = { studentId: string } | { groupId: string };

export interface GrantInput {
  subjectType: GrantSubjectType;
  subjectId: string;
  grantee: Grantee;
  /** Delayed opening («открыть 1 ноября»); null = now. */
  availableFrom?: Date | null;
  availableUntil?: Date | null;
}

export interface GrantResult {
  grant: AccessGrantRow;
  /** Students who can see the subject because of this grant, as of now (new group members join later). */
  studentIds: string[];
}

export type LessonGrantTarget = { materialId: string } | { collectionId: string };

/**
 * 5.9.3: who may see a material, a collection or an assignment. A grant to a group follows its membership
 * (new members are included while the grant is live); revoking hides the subject without a message (MAT-02).
 * `content.granted` carries the students to notify (`material.granted`).
 */
@Injectable()
export class GrantsUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly grants: GrantRepository,
    private readonly materials: MaterialRepository,
    private readonly links: TeacherStudentRepository,
    private readonly groups: GroupRepository,
    private readonly features: FeatureService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  async grant(actor: Actor, input: GrantInput): Promise<GrantResult> {
    assertRole(actor, 'TEACHER');
    await this.features.assertEnabled(actor.accountId, 'materials');
    if (input.availableFrom && input.availableUntil && input.availableFrom >= input.availableUntil)
      throw AppError.validation('availableFrom must be before availableUntil');
    if (input.availableUntil && input.availableUntil.getTime() <= this.clock.now().getTime())
      throw AppError.validation('availableUntil is already in the past');
    return this.txm.run(async () => {
      await this.assertSubject(actor, input.subjectType, input.subjectId);
      const studentIds = await this.resolveGrantee(actor, input.grantee);
      const grant = await this.grants.insert({
        teacherId: actor.accountId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        granteeType: 'studentId' in input.grantee ? 'student' : 'group',
        granteeId: 'studentId' in input.grantee ? input.grantee.studentId : input.grantee.groupId,
        availableFrom: input.availableFrom ?? null,
        availableUntil: input.availableUntil ?? null,
        grantedBy: actor.accountId,
        sourceLessonId: null,
      });
      await this.record(actor, 'grant.created', grant, { students: studentIds.length });
      await this.publish(grant, studentIds);
      return { grant, studentIds };
    });
  }

  /**
   * Materials of a lesson handed to its participants (5.9.3 «Через занятие»), one grant per student. The
   * unique index makes a redelivered event or a concurrent attach a no-op; a grant the teacher revoked is not
   * re-issued either (the index ignores `revoked_at`).
   */
  async grantFromLesson(
    actor: Actor,
    lessonId: string,
    studentIds: readonly string[],
    targets: readonly LessonGrantTarget[],
  ): Promise<void> {
    await this.txm.run(async () => {
      for (const target of targets) {
        const subjectType: GrantSubjectType = 'materialId' in target ? 'material' : 'collection';
        const subjectId = 'materialId' in target ? target.materialId : target.collectionId;
        for (const studentId of studentIds) {
          const grant = await this.grants.insertFromLesson({
            teacherId: actor.accountId,
            subjectType,
            subjectId,
            granteeType: 'student',
            granteeId: studentId,
            availableFrom: null,
            availableUntil: null,
            grantedBy: actor.accountId,
            sourceLessonId: lessonId,
          });
          if (grant) await this.publish(grant, [studentId]);
        }
      }
    });
  }

  /** A student removed from a lesson loses what that lesson handed out (no message, MAT-02). */
  async revokeLessonGrants(lessonId: string, studentId: string): Promise<number> {
    return this.txm.run(async () => {
      const live = await this.grants.listBySourceLesson(lessonId, studentId);
      for (const g of live) await this.grants.revoke(g.id, this.clock.now());
      return live.length;
    });
  }

  async revoke(actor: Actor, grantId: string): Promise<AccessGrantRow> {
    assertRole(actor, 'TEACHER');
    return this.txm.run(async () => {
      const grant = await this.grants.findById(grantId);
      if (!grant || grant.teacherId !== actor.accountId) throw AppError.notFound('grant', grantId);
      if (grant.revokedAt) return grant;
      const revoked = (await this.grants.revoke(grant.id, this.clock.now())) ?? grant;
      await this.record(actor, 'grant.revoked', revoked, null);
      await this.outbox.publish({
        type: 'content.revoked',
        aggregateType: 'access_grant',
        aggregateId: revoked.id,
        payload: { grantId: revoked.id, subjectType: revoked.subjectType, subjectId: revoked.subjectId },
      });
      return revoked;
    });
  }

  async listForSubject(
    actor: Actor,
    subjectType: GrantSubjectType,
    subjectId: string,
  ): Promise<AccessGrantRow[]> {
    assertRole(actor, 'TEACHER');
    await this.assertSubject(actor, subjectType, subjectId, { allowArchived: true });
    return this.grants.listBySubject(subjectType, subjectId);
  }

  /** Current students a grantee stands for; the teacher must own the link or the group (8.0). */
  async resolveGrantee(actor: Actor, grantee: Grantee): Promise<string[]> {
    if ('studentId' in grantee) {
      const link = await this.links.findByPair(actor.accountId, grantee.studentId);
      if (link?.status !== 'active')
        throw new AppError('LINK_NOT_ACTIVE', 'The student is not yours', { reason: 'not_linked' });
      return [grantee.studentId];
    }
    const group = await this.groups.findById(grantee.groupId);
    if (!group || group.teacherId !== actor.accountId || group.archivedAt)
      throw AppError.notFound('group', grantee.groupId);
    return (await this.groups.listMembers(group.id)).map((m) => m.studentId);
  }

  private async assertSubject(
    actor: Actor,
    subjectType: GrantSubjectType,
    subjectId: string,
    options: { allowArchived?: boolean } = {},
  ): Promise<void> {
    if (subjectType === 'assignment') return; // the homework module owns that check (M5-03)
    const row =
      subjectType === 'material'
        ? await this.materials.findById(subjectId)
        : await this.materials.findCollection(subjectId);
    if (!row || row.teacherId !== actor.accountId || (row.archivedAt && !options.allowArchived))
      throw AppError.notFound(subjectType, subjectId);
  }

  private async publish(grant: AccessGrantRow, studentIds: readonly string[]): Promise<void> {
    await this.outbox.publish({
      type: 'content.granted',
      aggregateType: 'access_grant',
      aggregateId: grant.id,
      payload: {
        grantId: grant.id,
        teacherId: grant.teacherId,
        subjectType: grant.subjectType,
        subjectId: grant.subjectId,
        studentIds: [...studentIds],
        availableFrom: grant.availableFrom?.toISOString() ?? null,
        sourceLessonId: grant.sourceLessonId,
      },
    });
  }

  private async record(
    actor: Actor,
    action: string,
    grant: AccessGrantRow,
    after: Record<string, unknown> | null,
  ): Promise<void> {
    await this.audit.record({
      actorId: actor.accountId,
      actorRole: 'TEACHER',
      action,
      entityType: 'access_grant',
      entityId: grant.id,
      after: {
        subjectType: grant.subjectType,
        subjectId: grant.subjectId,
        granteeType: grant.granteeType,
        ...after,
      },
      source: actor.source,
      ip: actor.ip,
    });
  }
}
