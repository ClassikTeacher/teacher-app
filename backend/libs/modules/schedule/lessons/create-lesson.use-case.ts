import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock, DAY_MS, MINUTE_MS } from '@shared/time/clock.js';
import { type Actor, assertRole, primaryRole } from '@modules/access/actor.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { GroupRepository } from '@modules/people/groups/group.repository.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { SubjectRepository } from '@modules/people/subject.repository.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { OccupancyService } from '../occupancy/occupancy.service.js';
import type { CreatedVia, Interval, LessonParticipantRow, LessonRow } from '../schema.js';
import { LessonRepository } from './lesson.repository.js';
import {
  type LessonDetailsInput,
  MAX_LESSON_HORIZON_DAYS,
  normalizeDuration,
  normalizeLessonDetails,
} from './lesson.rules.js';
import { WindowsPolicy } from './windows.policy.js';

/** The audit role matches the actor id: a self-booking is recorded as the student's act (5.5.5). */
function input_createdBy_role(actor: Actor, createdBy: string | null): ReturnType<typeof primaryRole> {
  return createdBy && createdBy !== actor.accountId ? 'STUDENT' : primaryRole(actor);
}

export type LessonTarget = { studentId: string } | { groupId: string };

export interface CreateLessonInput extends LessonDetailsInput {
  target: LessonTarget;
  startsAt: Date;
  durationMin: number;
  createdVia?: CreatedVia;
  seriesId?: string | null;
  /** Who asked for the lesson when it is not the teacher (a student's self-booking, 5.5.5). */
  createdBy?: string;
}

export interface CreatedLesson {
  lesson: LessonRow;
  participants: LessonParticipantRow[];
}

interface ResolvedTarget {
  studentIds: string[];
  groupId: string | null;
  linkId: string | null;
  defaultSubjectId: string | null;
}

/**
 * UC-14 step 3 / 5.6.1: creates an individual or group lesson together with the occupancy of every participant
 * in one transaction (CAL-01). The subject defaults to the link's or the group's; individual lessons get the
 * next number of the pair. Windows do not limit the teacher (CAL-09), the lesson is only marked.
 */
@Injectable()
export class CreateLessonUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly lessons: LessonRepository,
    private readonly occupancy: OccupancyService,
    private readonly links: TeacherStudentRepository,
    private readonly groups: GroupRepository,
    private readonly profiles: TeacherProfileRepository,
    private readonly subjects: SubjectRepository,
    private readonly accounts: AccountRepository,
    private readonly windows: WindowsPolicy,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  async execute(actor: Actor, input: CreateLessonInput): Promise<CreatedLesson> {
    assertRole(actor, 'TEACHER');
    const now = this.clock.now();
    const during = this.interval(input, now);
    const details = normalizeLessonDetails(input);
    const teacherId = actor.accountId;
    const actorId = input.createdBy ?? (actor.source === 'system' ? null : actor.accountId);
    return this.txm.run(async () => {
      if (details.subjectId) await this.assertSubject(details.subjectId);
      const profile = await this.profiles.find(teacherId);
      if (!profile) throw AppError.notFound('teacher profile', teacherId);
      // ACC-01/ACC-02: a blocked teacher gets no new lessons (series run on their behalf with a synthetic actor)
      if ((await this.accounts.findById(teacherId))?.status === 'blocked')
        throw new AppError('ACCOUNT_BLOCKED', 'The teacher is blocked');
      const target = await this.resolveTarget(teacherId, input.target);
      const students = await this.accounts.findByIds(target.studentIds);
      const blocked = students.find((a) => a.status === 'blocked');
      if (blocked)
        throw new AppError('LINK_NOT_ACTIVE', 'The student is blocked', {
          studentId: blocked.id,
          reason: 'student_blocked',
        });
      const outsideWindows = await this.windows.isOutsideWindows(teacherId, during);
      const lesson = await this.lessons.insert({
        teacherId,
        groupId: target.groupId,
        seriesId: input.seriesId ?? null,
        startsAt: during.start,
        endsAt: during.end,
        subjectId: details.subjectId ?? target.defaultSubjectId,
        plannedTopic: details.plannedTopic ?? null,
        format: details.format ?? null,
        location: details.location ?? null,
        meetingUrl: details.meetingUrl ?? null,
        teacherNotes: details.teacherNotes ?? null,
        seqNo: target.linkId ? await this.lessons.nextSeq(target.linkId) : null,
        outsideWindows,
        createdBy: actorId,
        createdVia: input.createdVia ?? 'teacher',
      });
      const participants = await this.lessons.addParticipants(lesson.id, target.studentIds, now);
      await this.occupancy.reserve({
        source: { kind: 'lesson', lessonId: lesson.id },
        during,
        teacher: {
          accountId: teacherId,
          bufferBeforeMin: profile.bufferBeforeMin,
          bufferAfterMin: profile.bufferAfterMin,
        },
        studentIds: target.studentIds,
      });
      await this.record(actor, lesson, target, during, outsideWindows, now);
      return { lesson, participants };
    });
  }

  private async record(
    actor: Actor,
    lesson: LessonRow,
    target: ResolvedTarget,
    during: Interval,
    outsideWindows: boolean,
    now: Date,
  ): Promise<void> {
    const actorId = lesson.createdBy; // the student for a self-booking (5.5.5), else the teacher or null
    const summary = {
      startsAt: during.start.toISOString(),
      endsAt: during.end.toISOString(),
      groupId: target.groupId,
      via: lesson.createdVia,
      outsideWindows,
    };
    await this.lessons.addEvent({
      lessonId: lesson.id,
      type: 'created',
      actorId,
      payload: { ...summary, studentIds: target.studentIds },
      at: now,
    });
    await this.audit.record({
      actorId,
      actorRole: input_createdBy_role(actor, lesson.createdBy),
      action: 'lesson.created',
      entityType: 'lesson',
      entityId: lesson.id,
      after: { ...summary, participants: target.studentIds.length },
      source: actor.source,
      ip: actor.ip,
    });
    await this.outbox.publish({
      type: 'lesson.created',
      aggregateType: 'lesson',
      aggregateId: lesson.id,
      payload: {
        lessonId: lesson.id,
        teacherId: lesson.teacherId,
        groupId: target.groupId,
        studentIds: target.studentIds,
        startsAt: summary.startsAt,
        endsAt: summary.endsAt,
        version: lesson.version,
        createdVia: lesson.createdVia,
      },
    });
  }

  private interval(input: CreateLessonInput, now: Date): Interval {
    const durationMin = normalizeDuration(input.durationMin);
    const start = input.startsAt;
    if (Number.isNaN(start.getTime())) throw AppError.validation('startsAt is invalid');
    if (start.getTime() - now.getTime() > MAX_LESSON_HORIZON_DAYS * DAY_MS)
      throw AppError.validation('Lesson is too far ahead', { maxDays: MAX_LESSON_HORIZON_DAYS });
    const end = new Date(start.getTime() + durationMin * MINUTE_MS);
    if (end.getTime() <= now.getTime())
      throw AppError.validation('Lesson is entirely in the past', { reason: 'past' });
    return { start, end };
  }

  private async assertSubject(subjectId: string): Promise<void> {
    const subject = await this.subjects.findById(subjectId);
    if (!subject?.isActive) throw AppError.validation('Unknown or inactive subject');
  }

  /** The student must be the teacher's active student; the group the teacher's own, not archived (8.0). */
  private async resolveTarget(teacherId: string, target: LessonTarget): Promise<ResolvedTarget> {
    if ('studentId' in target) {
      const link = await this.links.findByPair(teacherId, target.studentId, { forUpdate: true });
      if (!link || link.status !== 'active') {
        throw new AppError('LINK_NOT_ACTIVE', 'The student is not an active student of this teacher', {
          studentId: target.studentId,
        });
      }
      return {
        studentIds: [target.studentId],
        groupId: null,
        linkId: link.id,
        defaultSubjectId: link.subjectIds[0] ?? null,
      };
    }
    const group = await this.groups.findById(target.groupId, { forUpdate: true });
    if (!group || group.teacherId !== teacherId) throw AppError.notFound('group', target.groupId);
    if (group.archivedAt) throw new AppError('CONFLICT', 'Group is archived', { reason: 'archived' });
    const members = await this.groups.listMembers(group.id);
    if (members.length === 0)
      throw AppError.validation('The group has no members', { reason: 'empty_group', groupId: group.id });
    return {
      studentIds: members.map((m) => m.studentId),
      groupId: group.id,
      linkId: null,
      defaultSubjectId: group.subjectId,
    };
  }
}
