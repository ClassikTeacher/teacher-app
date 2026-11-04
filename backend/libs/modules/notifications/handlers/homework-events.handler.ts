import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { Clock, MINUTE_MS } from '@shared/time/clock.js';
import { formatInZone } from '@shared/time/timezone.js';
import { AssignmentRepository } from '@modules/homework/assignment.repository.js';
import { DUE_REMINDER_OFFSETS_MIN } from '@modules/homework/homework.rules.js';
import type { AssignmentRow, AssignmentTargetRow } from '@modules/homework/schema.js';
import { FileRepository } from '@modules/files/file.repository.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import type { AccountRow } from '@modules/identity/schema.js';
import { type DeliveredEvent, DomainEventBus } from '@modules/outbox/event-bus.js';
import { NotificationService } from '../notification.service.js';
import { NotificationRenderer } from '../render.js';
import { BUTTONS_PAYLOAD_KEY } from '../types.js';

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const uuid = z.string().uuid();
const targetRef = z.object({
  assignmentId: uuid,
  teacherId: uuid,
  targetId: uuid,
  studentId: uuid,
  dueAt: z.string().nullable().optional(),
});
const published = z.object({
  assignmentId: uuid,
  teacherId: uuid,
  targets: z.array(z.object({ targetId: uuid, studentId: uuid, dueAt: z.string().nullable() })),
});
const storageFull = z.object({ teacherId: uuid });
const infected = z.object({ fileId: uuid, uploadedBy: uuid, ownerTeacherId: uuid });
const withdrawn = z.object({ assignmentId: uuid, targetId: uuid, studentId: uuid });
const received = z.object({
  submissionId: uuid,
  assignmentId: uuid,
  targetId: uuid,
  teacherId: uuid,
  studentId: uuid,
  isLate: z.boolean(),
  attemptNo: z.number().int(),
});
const reviewed = z.object({
  submissionId: uuid,
  assignmentId: uuid,
  teacherId: uuid,
  studentId: uuid,
  decision: z.enum(['accepted', 'returned']),
  hasComment: z.boolean(),
  files: z.number().int(),
});

function parse<T>(schema: z.ZodType<T>, event: DeliveredEvent): T {
  const result = schema.safeParse(event.payload);
  if (!result.success)
    throw new UnrecoverableError(`malformed ${event.type} payload: ${result.error.message}`);
  return result.data;
}

const WHEN = 'ccc dd.MM HH:mm';

/**
 * Homework messages (5.10.5, 5.13.1): «Новое ДЗ» with the student's own due date, reminders 24 h and 2 h
 * before it (keys `homework.due_soon:<target>:<offset>:<due>`, replanned on every due change and dropped on
 * submission or withdrawal), «просрочено», «сдана работа» to the teacher with «Открыть», the verdict to the
 * student with a copy to parents by the teacher's rule.
 */
@Injectable()
export class HomeworkEventsHandler implements OnModuleInit {
  private readonly labels = new NotificationRenderer();

  constructor(
    private readonly bus: DomainEventBus,
    private readonly accounts: AccountRepository,
    private readonly assignments: AssignmentRepository,
    private readonly files: FileRepository,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.bus.on('homework.published', (e) => this.published(e));
    this.bus.on('homework.target_added', (e) => this.targetAdded(e));
    this.bus.on('homework.due_changed', (e) => this.dueChanged(e));
    this.bus.on('homework.withdrawn', (e) => this.withdrawn(e));
    this.bus.on('homework.overdue', (e) => this.overdue(e));
    this.bus.on('submission.received', (e) => this.received(e));
    this.bus.on('submission.reviewed', (e) => this.reviewed(e));
    this.bus.on('storage.full', (e) => this.storageFull(e));
    this.bus.on('file.infected', (e) => this.infected(e));
  }

  /** HW-05 / UC-27: the file is rejected after a deferred scan — the uploader (and the owner teacher) are told. */
  private async infected(event: DeliveredEvent): Promise<void> {
    const p = parse(infected, event);
    const file = await this.files.findById(p.fileId);
    const payload = { name: esc(file?.originalName ?? '—') };
    for (const recipientId of new Set([p.uploadedBy, p.ownerTeacherId])) {
      await this.notifications.schedule({
        type: 'file.infected',
        recipientId,
        payload,
        dedupeKey: `file.infected:${p.fileId}:${recipientId}`,
      });
    }
  }

  /** UC-27: once a day per teacher, however many students hit the wall. */
  private async storageFull(event: DeliveredEvent): Promise<void> {
    const p = parse(storageFull, event);
    const day = this.clock.now().toISOString().slice(0, 10);
    await this.notifications.schedule({
      type: 'storage.full',
      recipientId: p.teacherId,
      bot: 'staff',
      payload: {},
      dedupeKey: `storage.full:${p.teacherId}:${day}`,
    });
  }

  private async published(event: DeliveredEvent): Promise<void> {
    const p = parse(published, event);
    const assignment = await this.assignments.findById(p.assignmentId);
    if (!assignment) return;
    for (const t of p.targets) {
      const target = await this.assignments.findTarget(t.targetId);
      if (target) await this.announce(assignment, target);
    }
  }

  private async targetAdded(event: DeliveredEvent): Promise<void> {
    const p = parse(targetRef, event);
    const [assignment, target] = await Promise.all([
      this.assignments.findById(p.assignmentId),
      this.assignments.findTarget(p.targetId),
    ]);
    if (assignment && target) await this.announce(assignment, target);
  }

  private async announce(assignment: AssignmentRow, target: AssignmentTargetRow): Promise<void> {
    const [teacher, student] = await Promise.all([
      this.accounts.findById(assignment.teacherId),
      this.accounts.findById(target.studentId),
    ]);
    if (!teacher || !student) return;
    await this.notifications.schedule({
      type: 'homework.assigned',
      recipientId: student.id,
      bot: 'student',
      payload: {
        title: esc(assignment.title),
        teacher: esc(`${teacher.firstName} ${teacher.lastName}`.trim()),
        due: this.due(target, student),
        [BUTTONS_PAYLOAD_KEY]: [
          { text: this.labels.t('btn-open-assignment'), data: `s:assignments:a:${assignment.id}` },
        ],
      },
      dedupeKey: `homework.assigned:${target.id}`,
      teacherId: assignment.teacherId,
    });
    await this.planReminders(assignment, target, student);
  }

  private async dueChanged(event: DeliveredEvent): Promise<void> {
    const p = parse(targetRef, event);
    const [assignment, target, student] = await Promise.all([
      this.assignments.findById(p.assignmentId),
      this.assignments.findTarget(p.targetId),
      this.accounts.findById(p.studentId),
    ]);
    if (!assignment || !target || !student) return;
    await this.planReminders(assignment, target, student);
  }

  private async withdrawn(event: DeliveredEvent): Promise<void> {
    const p = parse(withdrawn, event);
    await this.notifications.cancelByPrefix(`homework.due_soon:${p.targetId}:`);
  }

  private async overdue(event: DeliveredEvent): Promise<void> {
    const p = parse(targetRef, event);
    const [assignment, target, student] = await Promise.all([
      this.assignments.findById(p.assignmentId),
      this.assignments.findTarget(p.targetId),
      this.accounts.findById(p.studentId),
    ]);
    if (!assignment || !target || !student || target.status !== 'overdue') return;
    await this.notifications.cancelByPrefix(`homework.due_soon:${target.id}:`);
    await this.notifications.schedule({
      type: 'homework.overdue',
      recipientId: student.id,
      bot: 'student',
      payload: {
        title: esc(assignment.title),
        due: this.due(target, student),
        [BUTTONS_PAYLOAD_KEY]: [
          { text: this.labels.t('btn-open-assignment'), data: `s:assignments:a:${assignment.id}` },
        ],
      },
      dedupeKey: `homework.overdue:${target.id}:${target.dueAt?.toISOString() ?? ''}`,
      teacherId: assignment.teacherId,
    });
  }

  /** `submission.received` → the teacher, with «Открыть» (UC-28 step 1); dropped from reminders. */
  private async received(event: DeliveredEvent): Promise<void> {
    const p = parse(received, event);
    await this.notifications.cancelByPrefix(`homework.due_soon:${p.targetId}:`);
    const [assignment, student] = await Promise.all([
      this.assignments.findById(p.assignmentId),
      this.accounts.findById(p.studentId),
    ]);
    if (!assignment || !student) return;
    await this.notifications.schedule({
      type: 'submission.received',
      recipientId: p.teacherId,
      bot: 'staff',
      payload: {
        student: esc(`${student.firstName} ${student.lastName}`.trim()),
        title: esc(assignment.title),
        late: p.isLate ? 'yes' : 'no',
        attempt: p.attemptNo,
        [BUTTONS_PAYLOAD_KEY]: [
          { text: this.labels.t('btn-open-submission'), data: `s:assignments:sub:${p.submissionId}` },
        ],
      },
      dedupeKey: `submission.received:${p.submissionId}`,
    });
  }

  /** `submission.reviewed` → the student (copy to parents by the teacher's rule, 5.10.4). */
  private async reviewed(event: DeliveredEvent): Promise<void> {
    const p = parse(reviewed, event);
    const assignment = await this.assignments.findById(p.assignmentId);
    if (!assignment) return;
    await this.notifications.schedule({
      type: 'submission.reviewed',
      recipientId: p.studentId,
      bot: 'student',
      payload: {
        title: esc(assignment.title),
        decision: p.decision,
        comment: p.hasComment ? 'yes' : 'no',
        files: p.files,
        [BUTTONS_PAYLOAD_KEY]: [
          { text: this.labels.t('btn-open-assignment'), data: `s:assignments:a:${assignment.id}` },
        ],
      },
      dedupeKey: `submission.reviewed:${p.submissionId}`,
      teacherId: assignment.teacherId,
    });
  }

  /** 5.10.5 💡: 24 h and 2 h before the student's own due date; the key carries the date (replanning). */
  private async planReminders(
    assignment: AssignmentRow,
    target: AssignmentTargetRow,
    student: AccountRow,
  ): Promise<void> {
    await this.notifications.cancelByPrefix(`homework.due_soon:${target.id}:`);
    if (!target.dueAt || target.status !== 'assigned') return;
    const now = this.clock.now();
    for (const offset of DUE_REMINDER_OFFSETS_MIN) {
      const dueAt = new Date(target.dueAt.getTime() - offset * MINUTE_MS);
      if (dueAt.getTime() <= now.getTime()) continue;
      await this.notifications.schedule({
        type: 'homework.due_soon',
        recipientId: student.id,
        bot: 'student',
        payload: {
          title: esc(assignment.title),
          due: this.due(target, student),
          hours: Math.round(offset / 60),
          [BUTTONS_PAYLOAD_KEY]: [
            { text: this.labels.t('btn-open-assignment'), data: `s:assignments:a:${assignment.id}` },
          ],
        },
        dedupeKey: `homework.due_soon:${target.id}:${offset}:${target.dueAt.toISOString()}`,
        dueAt,
        keepTime: true,
        teacherId: assignment.teacherId,
      });
    }
  }

  private due(target: AssignmentTargetRow, student: AccountRow): string {
    return target.dueAt ? formatInZone(target.dueAt, student.timezone, WHEN) : this.labels.t('hw-no-due');
  }
}
