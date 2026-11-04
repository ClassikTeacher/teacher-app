import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { formatInZone } from '@shared/time/timezone.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import type { AccountRow } from '@modules/identity/schema.js';
import { type DeliveredEvent, DomainEventBus } from '@modules/outbox/event-bus.js';
import { SubjectRepository } from '@modules/people/subject.repository.js';
import { NotificationService } from '../notification.service.js';
import { NotificationRenderer } from '../render.js';
import { BUTTONS_PAYLOAD_KEY } from '../types.js';

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const uuid = z.string().uuid();
const span = z.object({ startsAt: z.string().datetime(), endsAt: z.string().datetime() });
const rescheduled = z.object({
  lessonId: uuid,
  teacherId: uuid,
  subjectId: uuid.nullable().optional(),
  studentIds: z.array(uuid),
  from: span,
  to: span,
  version: z.number().int(),
  comment: z.string(),
  requestedBy: uuid.nullable().optional(),
});
const objection = z.object({
  lessonId: uuid,
  teacherId: uuid,
  studentId: uuid,
  startsAt: z.string().datetime(),
  reason: z.string(),
  byAccountId: uuid.nullable(),
  byRole: z.string(),
  version: z.number().int(),
});
const requested = z.object({
  requestId: uuid,
  teacherId: uuid,
  studentId: uuid,
  kind: z.string(),
  startsAt: z.string().datetime().nullable(),
  comment: z.string().nullable(),
  byAccountId: uuid.nullable(),
  byRole: z.string(),
});
const decided = z.object({
  requestId: uuid,
  teacherId: uuid,
  studentId: uuid,
  kind: z.string(),
  status: z.string(),
  reason: z.string(),
  message: z.string().nullable(),
  startsAt: z.string().datetime().nullable(),
  openSlots: z.array(z.string().datetime()),
});
const WHEN_FORMAT = 'ccc dd.MM HH:mm';

function parse<T>(schema: z.ZodType<T>, event: DeliveredEvent): T {
  const result = schema.safeParse(event.payload);
  if (!result.success)
    throw new UnrecoverableError(`malformed ${event.type} payload: ${result.error.message}`);
  return result.data;
}
const name = (a: AccountRow | null | undefined): string =>
  esc(a ? `${a.firstName} ${a.lastName}`.trim() : '—');

/**
 * 5.7.4 / 5.13.1 (M4-03): a move → every participant with «ОК / Не могу в это время» (the student whose request
 * was accepted gets the decision instead); an objection → the teacher; a request or a plea → the teacher with
 * «Подтвердить / Отклонить»; a decision → the student («слот занят» lists the open slots). Reminders of a moved
 * lesson are re-planned by `LessonEventsHandler` (NTF-05).
 */
@Injectable()
export class RescheduleEventsHandler implements OnModuleInit {
  private readonly labels = new NotificationRenderer();

  constructor(
    private readonly bus: DomainEventBus,
    private readonly accounts: AccountRepository,
    private readonly subjects: SubjectRepository,
    private readonly notifications: NotificationService,
  ) {}

  onModuleInit(): void {
    this.bus.on('lesson.rescheduled', (e) => this.rescheduled(e));
    this.bus.on('lesson.reschedule_objection', (e) => this.objection(e));
    this.bus.on('booking.requested', (e) => this.requested(e));
    this.bus.on('booking.decided', (e) => this.decided(e));
  }

  private async rescheduled(event: DeliveredEvent): Promise<void> {
    const p = parse(rescheduled, event);
    const [teacher, subject] = await Promise.all([
      this.accounts.findById(p.teacherId),
      p.subjectId ? this.subjects.findById(p.subjectId) : null,
    ]);
    const students = (await this.accounts.findByIds(p.studentIds)).filter((s) => s.id !== p.requestedBy);
    for (const student of students) {
      const buttons = [
        { text: this.labels.t('btn-move-ok'), data: `s:schedule:rok:${p.lessonId}` },
        { text: this.labels.t('btn-move-cannot'), data: `s:schedule:rno:${p.lessonId}` },
      ];
      await this.notifications.schedule({
        type: 'lesson.rescheduled',
        recipientId: student.id,
        bot: 'student',
        payload: {
          teacher: name(teacher),
          subject: subject ? ` (${esc(subject.name)})` : '',
          from: formatInZone(new Date(p.from.startsAt), student.timezone, WHEN_FORMAT),
          to: formatInZone(new Date(p.to.startsAt), student.timezone, WHEN_FORMAT),
          comment: esc(p.comment),
          [BUTTONS_PAYLOAD_KEY]: buttons,
        },
        dedupeKey: `lesson.rescheduled:${p.lessonId}:${p.version}:${student.id}`,
        teacherId: p.teacherId,
        // NTF-02 / NTF-06: the urgency follows the sooner of the two times (M-4)
        lessonStartsAt: new Date(
          Math.min(new Date(p.from.startsAt).getTime(), new Date(p.to.startsAt).getTime()),
        ),
      });
    }
  }

  private async objection(event: DeliveredEvent): Promise<void> {
    const p = parse(objection, event);
    const [teacher, student, by] = await Promise.all([
      this.accounts.findById(p.teacherId),
      this.accounts.findById(p.studentId),
      p.byAccountId ? this.accounts.findById(p.byAccountId) : null,
    ]);
    if (!teacher) return;
    await this.notifications.schedule({
      type: 'lesson.reschedule_objection',
      recipientId: teacher.id,
      payload: {
        view: p.byRole === 'PARENT' ? 'by-parent' : 'by-student',
        student: name(student),
        by: name(by),
        when: formatInZone(new Date(p.startsAt), teacher.timezone, WHEN_FORMAT),
        reason: esc(p.reason),
        [BUTTONS_PAYLOAD_KEY]: [
          { text: this.labels.t('btn-lesson-card'), data: `s:today:lesson:${p.lessonId}` },
        ],
      },
      dedupeKey: `lesson.reschedule_objection:${p.lessonId}:${p.version}:${p.studentId}`,
    });
  }

  private async requested(event: DeliveredEvent): Promise<void> {
    const p = parse(requested, event);
    const [teacher, student, by] = await Promise.all([
      this.accounts.findById(p.teacherId),
      this.accounts.findById(p.studentId),
      p.byAccountId ? this.accounts.findById(p.byAccountId) : null,
    ]);
    if (!teacher) return;
    const buttons =
      p.kind === 'reschedule_ask'
        ? [{ text: this.labels.t('btn-lesson-card'), data: `s:today:rq:${p.requestId}:card` }]
        : [
            { text: this.labels.t('btn-request-accept'), data: `s:today:rq:${p.requestId}:ok` },
            { text: this.labels.t('btn-request-decline'), data: `s:today:rq:${p.requestId}:no` },
          ];
    await this.notifications.schedule({
      type: 'booking.requested',
      recipientId: teacher.id,
      payload: {
        view: p.kind,
        student: name(student),
        by: p.byRole === 'PARENT' ? ` (${this.labels.t('ntf-by-parent')} ${name(by)})` : '',
        when: p.startsAt ? formatInZone(new Date(p.startsAt), teacher.timezone, WHEN_FORMAT) : '',
        comment: esc(p.comment ?? ''),
        [BUTTONS_PAYLOAD_KEY]: buttons,
      },
      dedupeKey: `booking.requested:${p.requestId}`,
    });
  }

  private async decided(event: DeliveredEvent): Promise<void> {
    const p = parse(decided, event);
    const [teacher, student] = await Promise.all([
      this.accounts.findById(p.teacherId),
      this.accounts.findById(p.studentId),
    ]);
    if (!student) return;
    const slots = p.openSlots.map((s) => formatInZone(new Date(s), student.timezone, WHEN_FORMAT)).join(', ');
    await this.notifications.schedule({
      type: 'booking.decided',
      recipientId: student.id,
      bot: 'student',
      payload: {
        view: p.reason,
        kind: p.kind,
        teacher: name(teacher),
        when: p.startsAt ? formatInZone(new Date(p.startsAt), student.timezone, WHEN_FORMAT) : '',
        message: esc(p.message ?? ''),
        slots: slots || this.labels.t('ntf-no-open-slots'),
      },
      dedupeKey: `booking.decided:${p.requestId}:${p.status}`,
      teacherId: p.teacherId,
      lessonStartsAt: p.startsAt ? new Date(p.startsAt) : null,
    });
  }
}
