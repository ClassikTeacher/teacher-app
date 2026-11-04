import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { type Actor, assertRole, primaryRole } from '@modules/access/actor.js';
import { FeatureService } from '@modules/access/features/feature.service.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { TeacherStudentRepository } from '../links/teacher-student.repository.js';
import type { StudyGroupRow } from '../schema.js';
import { SubjectRepository } from '../subject.repository.js';
import { MAX_LESSON_DURATION_MIN, MIN_LESSON_DURATION_MIN } from '../teacher-profile.defaults.js';
import { isValidGroupEmoji } from './group-emoji.js';
import { GroupRepository } from './group.repository.js';

export interface GroupInput {
  name?: string;
  subjectId?: string | null;
  emoji?: string | null;
  defaultDurationMin?: number | null;
}

export const MAX_GROUP_NAME = 100;
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const e = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const code = e.code ?? e.cause?.code;
  const name = e.constraint ?? e.cause?.constraint;
  return code === UNIQUE_VIOLATION && name === constraint;
}

/**
 * UC-12: groups of a teacher (5.4.4) — create, edit, archive, change membership. Members must be the teacher's
 * active students (8.0). Membership changes raise events that scheduling applies to future lessons (M3-02).
 */
@Injectable()
export class GroupsUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly groups: GroupRepository,
    private readonly links: TeacherStudentRepository,
    private readonly subjects: SubjectRepository,
    private readonly features: FeatureService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    private readonly accounts: AccountRepository,
  ) {}

  /** Feature and limit check up front, so the bot can refuse before the four-step dialog (no lock, advisory). */
  async assertCanCreate(actor: Actor): Promise<void> {
    assertRole(actor, 'TEACHER');
    await this.features.assertEnabled(actor.accountId, 'groups');
    await this.assertUnderLimit(actor.accountId);
  }

  private async assertUnderLimit(teacherId: string): Promise<void> {
    const limit = await this.features.limit(teacherId, 'groups', 'maxGroups');
    if (limit !== null && (await this.groups.countActiveByTeacher(teacherId)) >= limit) {
      throw new AppError('LIMIT_EXCEEDED', 'Group limit reached', { limit: 'maxGroups', max: limit });
    }
  }

  async create(actor: Actor, input: GroupInput): Promise<StudyGroupRow> {
    assertRole(actor, 'TEACHER');
    await this.features.assertEnabled(actor.accountId, 'groups');
    const clean = await this.validate(input);
    if (!clean.name) throw AppError.validation('Group name is required');
    return this.txm.run(async () => {
      await this.links.lockTeacherSeats(actor.accountId); // same per-teacher lock keeps the group count race-free
      await this.assertUnderLimit(actor.accountId);
      const group = await this.txm
        .runSavepoint(() =>
          this.groups.insert({
            teacherId: actor.accountId,
            name: clean.name!,
            subjectId: clean.subjectId ?? null,
            emoji: clean.emoji ?? null,
            defaultDurationMin: clean.defaultDurationMin ?? null,
          }),
        )
        .catch((error: unknown) => {
          if (isUniqueViolation(error, 'study_group_name_uniq')) {
            throw new AppError('CONFLICT', 'A group with this name already exists', {
              reason: 'duplicate_name',
            });
          }
          throw error;
        });
      await this.record(actor, 'group.created', group.id, null, {
        name: group.name,
        subjectId: group.subjectId,
      });
      return group;
    });
  }

  async update(actor: Actor, groupId: string, input: GroupInput): Promise<StudyGroupRow> {
    assertRole(actor, 'TEACHER');
    await this.features.assertEnabled(actor.accountId, 'groups');
    const clean = await this.validate(input);
    if (Object.keys(clean).length === 0) throw AppError.validation('Nothing to update');
    return this.txm.run(async () => {
      const group = await this.ownActiveGroup(actor, groupId);
      const updated = await this.txm
        .runSavepoint(() => this.groups.update(group.id, clean))
        .catch((error: unknown) => {
          if (isUniqueViolation(error, 'study_group_name_uniq')) {
            throw new AppError('CONFLICT', 'A group with this name already exists', {
              reason: 'duplicate_name',
            });
          }
          throw error;
        });
      await this.record(
        actor,
        'group.updated',
        group.id,
        { name: group.name },
        { fields: Object.keys(clean) },
      );
      return updated;
    });
  }

  /** Archiving closes memberships; future lessons are handled by scheduling (M3/M4). */
  async archive(actor: Actor, groupId: string): Promise<StudyGroupRow> {
    assertRole(actor, 'TEACHER');
    const now = this.clock.now();
    return this.txm.run(async () => {
      const group = await this.ownActiveGroup(actor, groupId);
      const members = await this.groups.removeAllMembers(group.id, now);
      const archived = await this.groups.update(group.id, { archivedAt: now });
      await this.record(actor, 'group.archived', group.id, null, { members: members.length });
      await this.outbox.publish({
        type: 'group.archived',
        aggregateType: 'study_group',
        aggregateId: group.id,
        payload: {
          groupId: group.id,
          teacherId: actor.accountId,
          memberships: members.map((m) => ({ membershipId: m.id, studentId: m.studentId })),
          at: now.toISOString(),
        },
      });
      return archived;
    });
  }

  /** Adds the teacher's active student; a student may be in several groups of one teacher (5.4.4). */
  async addMember(actor: Actor, groupId: string, studentId: string): Promise<void> {
    assertRole(actor, 'TEACHER');
    await this.features.assertEnabled(actor.accountId, 'groups');
    const now = this.clock.now();
    await this.txm.run(async () => {
      const group = await this.ownActiveGroup(actor, groupId);
      // the link row is locked: ending the link (which closes memberships) cannot interleave with joining
      const link = await this.links.findByPair(actor.accountId, studentId, { forUpdate: true });
      if ((await this.accounts.findById(studentId))?.status === 'blocked')
        throw new AppError('LINK_NOT_ACTIVE', 'The student is blocked', {
          studentId,
          reason: 'student_blocked',
        }); // L-5
      if (!link || link.status !== 'active') {
        throw new AppError('LINK_NOT_ACTIVE', 'Only active students can join a group', { studentId });
      }
      const member = await this.txm
        .runSavepoint(() => this.groups.addMember(group.id, studentId, now))
        .catch((error: unknown) => {
          if (isUniqueViolation(error, 'group_member_active_uniq')) {
            throw new AppError('CONFLICT', 'Student is already in the group', { reason: 'already_member' });
          }
          throw error;
        });
      await this.record(actor, 'group.member_added', group.id, null, { studentId });
      await this.outbox.publish({
        type: 'group.member_added',
        aggregateType: 'study_group',
        aggregateId: group.id,
        payload: {
          groupId: group.id,
          teacherId: actor.accountId,
          studentId,
          membershipId: member.id,
          at: now.toISOString(),
        },
      });
    });
  }

  async removeMember(actor: Actor, groupId: string, studentId: string): Promise<void> {
    assertRole(actor, 'TEACHER');
    await this.features.assertEnabled(actor.accountId, 'groups');
    const now = this.clock.now();
    await this.txm.run(async () => {
      const group = await this.ownActiveGroup(actor, groupId);
      const removed = await this.groups.removeMember(group.id, studentId, now);
      if (!removed) throw new AppError('CONFLICT', 'Student is not in the group', { reason: 'not_member' });
      await this.record(actor, 'group.member_removed', group.id, null, { studentId });
      await this.outbox.publish({
        type: 'group.member_removed',
        aggregateType: 'study_group',
        aggregateId: group.id,
        payload: {
          groupId: group.id,
          teacherId: actor.accountId,
          studentId,
          membershipId: removed.id,
          at: now.toISOString(),
        },
      });
    });
  }

  private async ownActiveGroup(actor: Actor, groupId: string): Promise<StudyGroupRow> {
    const group = await this.groups.findById(groupId, { forUpdate: true });
    if (!group || group.teacherId !== actor.accountId) throw AppError.notFound('group', groupId);
    if (group.archivedAt) throw new AppError('CONFLICT', 'Group is archived', { reason: 'archived' });
    return group;
  }

  private async validate(input: GroupInput): Promise<GroupInput> {
    const clean: GroupInput = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name || name.length > MAX_GROUP_NAME)
        throw AppError.validation('Group name is required and limited');
      clean.name = name;
    }
    if (input.subjectId !== undefined) {
      if (input.subjectId !== null) {
        const found = await this.subjects.findByIds([input.subjectId]);
        if (found.length !== 1 || !found[0]!.isActive)
          throw AppError.validation('Unknown or inactive subject');
      }
      clean.subjectId = input.subjectId;
    }
    if (input.emoji !== undefined) {
      const emoji = input.emoji?.trim() ?? '';
      if (emoji && !isValidGroupEmoji(emoji)) throw AppError.validation('emoji must be a single emoji');
      clean.emoji = emoji || null;
    }
    if (input.defaultDurationMin !== undefined) {
      const d = input.defaultDurationMin;
      if (
        d !== null &&
        (!Number.isInteger(d) || d < MIN_LESSON_DURATION_MIN || d > MAX_LESSON_DURATION_MIN)
      ) {
        throw AppError.validation('Lesson duration is out of range');
      }
      clean.defaultDurationMin = d;
    }
    return clean;
  }

  private record(
    actor: Actor,
    action: string,
    groupId: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record({
      actorId: actor.accountId,
      actorRole: primaryRole(actor),
      action,
      entityType: 'study_group',
      entityId: groupId,
      before,
      after,
      source: actor.source,
      ip: actor.ip,
    });
  }
}
