import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { type DeliveredEvent, DomainEventBus } from '@modules/outbox/event-bus.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { GroupRepository } from '@modules/people/groups/group.repository.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { OccupancyService } from '../occupancy/occupancy.service.js';
import type { LessonRow } from '../schema.js';
import { LessonRepository } from './lesson.repository.js';

const uuid = z.string().uuid();
const memberChanged = z.object({ groupId: uuid, teacherId: uuid, studentId: uuid });
const groupArchived = z.object({
  groupId: uuid,
  teacherId: uuid,
  memberships: z.array(z.object({ studentId: uuid })),
});
const linkEnded = z.object({ teacherId: uuid, studentId: uuid, groupIds: z.array(uuid) });

function parse<T>(schema: z.ZodType<T>, event: DeliveredEvent): T {
  const result = schema.safeParse(event.payload);
  if (!result.success)
    throw new UnrecoverableError(`malformed ${event.type} payload: ${result.error.message}`);
  return result.data;
}

/**
 * M3-02 contract from M2-05/M2-06: membership changes apply to the group's *future* scheduled lessons.
 * Added members join every future lesson they are free for; lessons they collide with are reported to the
 * teacher (`lesson.member_conflicts`). Removed members (also via `group.archived` and `link.ended`) leave future
 * lessons and their occupancy is released. Idempotent: re-delivery finds nothing left to do.
 */
@Injectable()
export class GroupMembershipHandler implements OnModuleInit {
  private readonly logger = new Logger(GroupMembershipHandler.name);

  constructor(
    private readonly bus: DomainEventBus,
    private readonly txm: TransactionManager,
    private readonly lessons: LessonRepository,
    private readonly groups: GroupRepository,
    private readonly links: TeacherStudentRepository,
    private readonly occupancy: OccupancyService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  /**
   * Delivery is at-least-once and may be out of order: a `member_added` is applied only while the student is
   * still an active member of a live group with an active link, so a stale event cannot bring a student back.
   * The group row is locked, which also serialises with CreateLessonUseCase (it locks the group too).
   */
  private async isCurrentMember(groupId: string, teacherId: string, studentId: string): Promise<boolean> {
    const group = await this.groups.findById(groupId, { forUpdate: true });
    if (!group || group.archivedAt) return false;
    const member = (await this.groups.listMembers(groupId)).some((m) => m.studentId === studentId);
    if (!member) return false;
    const link = await this.links.findByPair(teacherId, studentId);
    return link?.status === 'active';
  }

  onModuleInit(): void {
    this.bus.on('group.member_added', (e) => this.added(e));
    this.bus.on('group.member_removed', (e) => this.removed(e));
    this.bus.on('group.archived', (e) => this.archived(e));
    this.bus.on('link.ended', (e) => this.linkEnded(e));
  }

  private async added(event: DeliveredEvent): Promise<void> {
    const p = parse(memberChanged, event);
    const now = this.clock.now();
    const conflicts: LessonRow[] = [];
    let joined = 0;
    await this.txm.run(async () => {
      if (!(await this.isCurrentMember(p.groupId, p.teacherId, p.studentId))) return;
      for (const lesson of await this.lessons.lockFutureByGroup(p.groupId, now)) {
        const inserted = await this.lessons.addParticipants(lesson.id, [p.studentId], now);
        if (inserted.length === 0) continue; // already a participant: re-delivery
        try {
          await this.occupancy.reserveStudent(lesson.id, p.studentId, {
            start: lesson.startsAt,
            end: lesson.endsAt,
          });
        } catch (error) {
          if (!AppError.is(error, 'LESSON_CONFLICT')) throw error;
          await this.lessons.removeParticipant(lesson.id, p.studentId, now);
          conflicts.push(lesson);
          continue;
        }
        joined += 1;
        await this.lessons.update(lesson.id, {}, { bumpVersion: true });
        await this.lessons.addEvent({
          lessonId: lesson.id,
          type: 'participant_added',
          actorId: null,
          payload: { studentId: p.studentId, reason: 'group.member_added' },
          at: now,
        });
        await this.publishParticipants(lesson, [p.studentId], []);
      }
      if (conflicts.length > 0) {
        await this.outbox.publish({
          type: 'lesson.member_conflicts',
          aggregateType: 'study_group',
          aggregateId: p.groupId,
          payload: {
            groupId: p.groupId,
            teacherId: p.teacherId,
            studentId: p.studentId,
            sourceEventId: event.id, // one teacher message per membership event, however often it is delivered
            lessons: conflicts.map((l) => ({ lessonId: l.id, startsAt: l.startsAt.toISOString() })),
          },
        });
      }
    });
    this.logger.debug({ groupId: p.groupId, joined, conflicts: conflicts.length }, 'member applied');
  }

  private async removed(event: DeliveredEvent): Promise<void> {
    const p = parse(memberChanged, event);
    await this.leave(p.groupId, [p.studentId], 'group.member_removed');
  }

  private async archived(event: DeliveredEvent): Promise<void> {
    const p = parse(groupArchived, event);
    await this.leave(
      p.groupId,
      p.memberships.map((m) => m.studentId),
      'group.archived',
    );
  }

  private async linkEnded(event: DeliveredEvent): Promise<void> {
    const p = parse(linkEnded, event);
    for (const groupId of p.groupIds) await this.leave(groupId, [p.studentId], 'link.ended');
  }

  private async leave(groupId: string, studentIds: readonly string[], reason: string): Promise<void> {
    const now = this.clock.now();
    const leftLessons = new Map<string, string[]>(); // student → starts of the lessons they left (5.7.6 message)
    await this.txm.run(async () => {
      const group = await this.groups.findById(groupId, { forUpdate: true }); // same lock order as `added` and lesson creation
      for (const lesson of await this.lessons.lockFutureByGroup(groupId, now)) {
        const left: string[] = [];
        for (const studentId of studentIds) {
          const removed = await this.lessons.removeParticipant(lesson.id, studentId, now);
          if (!removed) continue;
          await this.occupancy.releaseLesson(lesson.id, studentId);
          left.push(studentId);
          leftLessons.set(studentId, [...(leftLessons.get(studentId) ?? []), lesson.startsAt.toISOString()]);
        }
        if (left.length === 0) continue;
        await this.lessons.update(lesson.id, {}, { bumpVersion: true });
        await this.lessons.addEvent({
          lessonId: lesson.id,
          type: 'participant_removed',
          actorId: null,
          payload: { studentIds: left, reason },
          at: now,
        });
        await this.publishParticipants(lesson, [], left);
      }
      // 5.7.6: one message per student about the lessons they lost («Вы исключены из группы» / archived)
      for (const [studentId, starts] of leftLessons) {
        await this.outbox.publish({
          type: 'group.lessons_left',
          aggregateType: 'study_group',
          aggregateId: groupId,
          payload: {
            groupId,
            groupName: group?.name ?? '',
            teacherId: group?.teacherId ?? null,
            studentId,
            reason,
            startsAt: starts,
          },
        });
      }
    });
  }

  private publishParticipants(lesson: LessonRow, added: string[], removed: string[]): Promise<string> {
    return this.outbox.publish({
      type: 'lesson.participants_changed',
      aggregateType: 'lesson',
      aggregateId: lesson.id,
      payload: {
        lessonId: lesson.id,
        teacherId: lesson.teacherId,
        groupId: lesson.groupId,
        startsAt: lesson.startsAt.toISOString(),
        endsAt: lesson.endsAt.toISOString(),
        added,
        removed,
      },
    });
  }
}
