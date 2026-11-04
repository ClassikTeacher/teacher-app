import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { type DeliveredEvent, DomainEventBus } from '@modules/outbox/event-bus.js';
import { LessonRepository } from '@modules/schedule/lessons/lesson.repository.js';
import { AssignmentRepository } from './assignment.repository.js';
import { AssignmentsUseCase } from './assignments.use-case.js';

const uuid = z.string().uuid();
const lessonRef = z.object({ lessonId: uuid, teacherId: uuid, studentIds: z.array(uuid).optional() });
const linkEnded = z.object({ teacherId: uuid, studentId: uuid });
const accountBlocked = z.object({ accountId: uuid });
const memberAdded = z.object({ groupId: uuid, teacherId: uuid, studentId: uuid });
const bulk = z.object({
  lessons: z.array(
    z.object({ lessonId: uuid, teacherId: uuid, studentIds: z.array(uuid), action: z.string() }),
  ),
});
const participantsChanged = z.object({ lessonId: uuid, added: z.array(uuid), removed: z.array(uuid) });

function parse<T>(schema: z.ZodType<T>, event: DeliveredEvent): T {
  const result = schema.safeParse(event.payload);
  if (!result.success)
    throw new UnrecoverableError(`malformed ${event.type} payload: ${result.error.message}`);
  return result.data;
}

/**
 * Keeps targets in step with the rest of the platform (5.10.1, 5.7.6, 5.8.4): a moved or cancelled lesson
 * recomputes «к следующему занятию» due dates (M4-03 contract), a new lesson gives a date to targets that
 * had none, an ended link or a blocked account withdraws open targets, a student joining a group becomes a
 * target of the group's published assignments. All steps are idempotent.
 */
@Injectable()
export class AssignmentEventsHandler implements OnModuleInit {
  constructor(
    private readonly bus: DomainEventBus,
    private readonly repo: AssignmentRepository,
    private readonly assignments: AssignmentsUseCase,
    private readonly lessons: LessonRepository,
  ) {}

  onModuleInit(): void {
    this.bus.on('lesson.rescheduled', (e) => this.lessonChanged(e));
    this.bus.on('lesson.cancelled', (e) => this.lessonChanged(e));
    this.bus.on('cancellation.bulk', (e) => this.bulkCancelled(e));
    this.bus.on('lesson.participants_changed', (e) => this.participantsChanged(e));
    this.bus.on('lesson.created', (e) => this.lessonCreated(e));
    this.bus.on('link.ended', (e) => this.linkEnded(e));
    this.bus.on('account.blocked', (e) => this.accountBlocked(e));
    this.bus.on('group.member_added', (e) => this.memberAdded(e));
  }

  private async lessonChanged(event: DeliveredEvent): Promise<void> {
    const p = parse(lessonRef, event);
    for (const t of await this.repo.listTargetsByDueLesson(p.lessonId))
      await this.assignments.recomputeDue(t);
    // a cancelled lesson may have been the «next» one of targets that follow another lesson: re-check them too
    await this.refreshNextLessonTargets(p.teacherId, p.studentIds ?? []);
  }

  /** 5.7.5 / 5.7.6: a bulk cancellation (holiday, paused series, group exit) is many `lesson.cancelled` at once. */
  private async bulkCancelled(event: DeliveredEvent): Promise<void> {
    const p = parse(bulk, event);
    for (const l of p.lessons) {
      if (l.action !== 'cancelled') continue;
      for (const t of await this.repo.listTargetsByDueLesson(l.lessonId))
        await this.assignments.recomputeDue(t);
      await this.refreshNextLessonTargets(l.teacherId, l.studentIds);
    }
  }

  /** A student removed from a group lesson their due date pointed to gets the next one; a joiner gets a date. */
  private async participantsChanged(event: DeliveredEvent): Promise<void> {
    const p = parse(participantsChanged, event);
    const lesson = p.removed.length + p.added.length > 0 ? await this.lessons.findById(p.lessonId) : null;
    if (!lesson) return;
    for (const t of await this.repo.listTargetsByDueLesson(p.lessonId)) {
      if (p.removed.includes(t.studentId)) await this.assignments.recomputeDue(t);
    }
    await this.refreshNextLessonTargets(lesson.teacherId, p.added);
  }

  private async lessonCreated(event: DeliveredEvent): Promise<void> {
    const p = parse(lessonRef, event);
    await this.refreshNextLessonTargets(p.teacherId, p.studentIds ?? []);
  }

  /** Open next-lesson targets of these students at this teacher get their date recomputed. */
  private async refreshNextLessonTargets(teacherId: string, studentIds: readonly string[]): Promise<void> {
    for (const studentId of studentIds) {
      for (const t of await this.repo.listOpenTargetsOfPair(teacherId, studentId)) {
        if (t.status === 'submitted') continue;
        await this.assignments.recomputeDue(t);
      }
    }
  }

  private async linkEnded(event: DeliveredEvent): Promise<void> {
    const p = parse(linkEnded, event);
    // 5.8.4: handed-in but unchecked work leaves the queue too — the former student gets no verdict
    for (const t of await this.repo.listOpenTargetsOfPair(p.teacherId, p.studentId))
      await this.assignments.withdraw(t, 'link_ended', { includeSubmitted: true });
  }

  private async accountBlocked(event: DeliveredEvent): Promise<void> {
    const p = parse(accountBlocked, event);
    const targets = await this.repo.listTargetsByStudent(p.accountId, [
      'assigned',
      'overdue',
      'returned',
      'submitted',
    ]);
    for (const t of targets)
      await this.assignments.withdraw(t, 'account_blocked', { includeSubmitted: true });
  }

  private async memberAdded(event: DeliveredEvent): Promise<void> {
    const p = parse(memberAdded, event);
    for (const a of await this.repo.listPublishedByGroup(p.groupId))
      await this.assignments.addTarget(a, p.studentId);
  }
}
