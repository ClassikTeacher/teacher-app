import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { formatInZone } from '@shared/time/timezone.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import type { AccountRow } from '@modules/identity/schema.js';
import { type DeliveredEvent, DomainEventBus } from '@modules/outbox/event-bus.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { SubjectRepository } from '@modules/people/subject.repository.js';
import { NotificationService } from '../notification.service.js';
import { NotificationRenderer } from '../render.js';

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const uuid = z.string().uuid();
const USER_ROLES = ['TEACHER', 'STUDENT', 'PARENT'] as const;
const cancelled = z.object({
  lessonId: uuid,
  teacherId: uuid,
  groupId: uuid.nullable(),
  studentIds: z.array(uuid),
  startsAt: z.string().datetime(),
  subjectId: uuid.nullable().optional(),
  message: z.string().nullable(),
  byAccountId: uuid.nullable(),
  byRole: z.string().optional(),
  onBehalfOfStudentId: uuid.nullable().optional(),
  isLate: z.boolean().optional(),
  kind: z.string().optional(),
});
const absence = cancelled.omit({ studentIds: true }).extend({ studentId: uuid });
const groupLeft = z.object({
  groupId: uuid,
  groupName: z.string(),
  teacherId: uuid.nullable(),
  studentId: uuid,
  reason: z.string(),
  startsAt: z.array(z.string().datetime()),
});
const bulk = z.object({
  cancellationId: uuid,
  byAccountId: uuid.nullable(),
  byRole: z.string(),
  source: z.string().optional(),
  /** The blocked person or the leaver: never a recipient of the summary about themselves. */
  subjectAccountId: uuid.nullable().optional(),
  onBehalfOfStudentId: uuid.nullable().optional(),
  message: z.string(),
  lessons: z.array(
    z.object({
      lessonId: uuid,
      teacherId: uuid,
      startsAt: z.string().datetime(),
      studentIds: z.array(uuid),
      action: z.enum(['cancelled', 'absence']),
      isLate: z.boolean(),
    }),
  ),
});
type BulkLesson = z.infer<typeof bulk>['lessons'][number];
const WHEN_FORMAT = 'ccc dd.MM HH:mm';
/** Dates listed in a bulk summary before «… (+N)». */
const SUMMARY_DATES = 12;

function parse<T>(schema: z.ZodType<T>, event: DeliveredEvent): T {
  const result = schema.safeParse(event.payload);
  if (!result.success)
    throw new UnrecoverableError(`malformed ${event.type} payload: ${result.error.message}`);
  return result.data;
}

const name = (a: AccountRow | null | undefined): string =>
  esc(a ? `${a.firstName} ${a.lastName}`.trim() : '—');

/**
 * CNL-05 (M4-01): a cancellation by a person reaches every other side — the teacher's → the students; the
 * student's → the teacher; a parent's → the teacher and the student. An absence notice (CNL-03) → the teacher
 * (and the student when a parent sent it). Copies to parents join the pipeline in M4-05; system cancellations
 * (5.7.6) get their texts in M4-06. Reminders of the lesson are dropped by `LessonEventsHandler`.
 */
@Injectable()
export class CancellationEventsHandler implements OnModuleInit {
  private readonly labels = new NotificationRenderer();

  constructor(
    private readonly bus: DomainEventBus,
    private readonly accounts: AccountRepository,
    private readonly subjects: SubjectRepository,
    private readonly family: FamilyLinkRepository,
    private readonly notifications: NotificationService,
  ) {}

  /** CNL-05: when the student cancels, the parents learn it as their own message (the student is not a recipient). */
  private async parentsFor(
    teacherId: string,
    studentId: string,
    type: 'lesson.cancelled' | 'cancellation.bulk',
  ): Promise<string[]> {
    if (!(await this.notifications.ccEnabled(teacherId, studentId, type))) return [];
    return (await this.family.listActiveByStudent(studentId)).map((l) => l.parentId);
  }

  /** A system message stored as a code is rendered by key; user text goes as is. */
  private systemText(message: string): string {
    return (
      this.labels.render({ typeCode: 'system.cancel', payload: { code: message.replace(/[._]/g, '-') } }) ??
      esc(message)
    );
  }

  onModuleInit(): void {
    this.bus.on('lesson.cancelled', (e) => this.cancelled(e));
    this.bus.on('lesson.absence', (e) => this.absence(e));
    this.bus.on('cancellation.bulk', (e) => this.bulk(e));
    this.bus.on('group.lessons_left', (e) => this.groupLeft(e));
  }

  /** 5.7.6: «Вы исключены из группы» (or the group was archived) with the dates the student lost. */
  private async groupLeft(event: DeliveredEvent): Promise<void> {
    const p = parse(groupLeft, event);
    const student = await this.accounts.findById(p.studentId);
    if (!student) return;
    const dates = p.startsAt.map((d) => formatInZone(new Date(d), student.timezone, WHEN_FORMAT));
    const shown = dates.slice(0, SUMMARY_DATES);
    await this.notifications.schedule({
      type: 'group.lessons_left',
      recipientId: student.id,
      bot: 'student',
      payload: {
        group: esc(p.groupName),
        reason: p.reason.replace(/[._]/g, '-'),
        dates: shown.join(', ') + (dates.length > shown.length ? ` … (+${dates.length - shown.length})` : ''),
      },
      dedupeKey: `group.lessons_left:${event.id}`,
      ...(p.teacherId ? { teacherId: p.teacherId } : {}),
      lessonStartsAt: p.startsAt[0] ? new Date(p.startsAt[0]) : null,
    });
  }

  /** 5.7.5 / NTF-07: one message per recipient listing their lessons of the batch. */
  private async bulk(event: DeliveredEvent): Promise<void> {
    const p = parse(bulk, event);
    const [by, child] = await Promise.all([
      p.byAccountId ? this.accounts.findById(p.byAccountId) : null,
      p.onBehalfOfStudentId ? this.accounts.findById(p.onBehalfOfStudentId) : null,
    ]);
    // recipient → their lessons: students of a teacher's batch; teachers (and the child) of a person's batch
    const perRecipient = new Map<string, BulkLesson[]>();
    const add = (id: string, l: BulkLesson) => perRecipient.set(id, [...(perRecipient.get(id) ?? []), l]);
    const parentsOfLeaver =
      p.byRole === 'STUDENT' && p.byAccountId
        ? await this.parentsFor(p.lessons[0]?.teacherId ?? '', p.byAccountId, 'cancellation.bulk')
        : [];
    for (const l of p.lessons) {
      if (p.byRole === 'TEACHER') l.studentIds.forEach((s) => add(s, l));
      else if (p.byRole === 'STUDENT') {
        add(l.teacherId, l);
        parentsOfLeaver.forEach((id) => add(id, l)); // CNL-05
      } else if (p.byRole === 'SYSTEM') {
        // 5.7.6: everyone involved except whoever caused it (the teacher who paused a series, the leaver)
        [...l.studentIds, l.teacherId]
          .filter((id) => id !== p.byAccountId && id !== p.subjectAccountId)
          .forEach((id) => add(id, l));
      } else {
        add(l.teacherId, l);
        if (p.byRole === 'PARENT' && child) add(child.id, l);
      }
    }
    const teachers = await this.accounts.findByIds([...new Set(p.lessons.map((l) => l.teacherId))]);
    const teacherName = new Map(teachers.map((t) => [t.id, name(t)]));
    for (const recipient of await this.accounts.findByIds([...perRecipient.keys()])) {
      const mine = perRecipient.get(recipient.id)!;
      const isTeacher = mine.some((l) => l.teacherId === recipient.id);
      const isParentOfLeaver = parentsOfLeaver.includes(recipient.id);
      // the first dates only: a summary of a long period must stay under Telegram's message limit
      const list = (action: BulkLesson['action']) => {
        const dates = mine
          .filter((l) => l.action === action)
          .map((l) => formatInZone(new Date(l.startsAt), recipient.timezone, WHEN_FORMAT));
        const shown = dates.slice(0, SUMMARY_DATES);
        return shown.join(', ') + (dates.length > shown.length ? ` … (+${dates.length - shown.length})` : '');
      };
      const view =
        p.byRole === 'SYSTEM'
          ? isTeacher
            ? 'system-to-teacher'
            : 'system-to-student'
          : isParentOfLeaver
            ? 'by-student-to-parent'
            : isTeacher
              ? p.byRole === 'PARENT'
                ? 'by-parent'
                : 'by-student'
              : p.byRole === 'TEACHER'
                ? 'by-teacher'
                : 'to-student';
      const studentNames = isTeacher
        ? (await this.accounts.findByIds([...new Set(mine.flatMap((l) => l.studentIds))]))
            .map(name)
            .join(', ')
        : '';
      await this.notifications.schedule({
        type: 'cancellation.bulk',
        recipientId: recipient.id,
        ...(isTeacher ? {} : { bot: isParentOfLeaver ? ('parent' as const) : ('student' as const) }),
        payload: {
          view,
          by: name(by),
          child: name(child),
          teacher: teacherName.get(mine[0]!.teacherId) ?? '—',
          cancelled: list('cancelled'),
          cancelledCount: mine.filter((l) => l.action === 'cancelled').length,
          absences: list('absence'),
          absenceCount: mine.filter((l) => l.action === 'absence').length,
          message: p.byRole === 'SYSTEM' ? this.systemText(p.message) : esc(p.message),
          lateMark: mine.some((l) => l.isLate) ? this.labels.t('ntf-late-mark') : '',
          student: studentNames,
          cause:
            this.labels.render({
              typeCode: 'cancel.cause',
              payload: { source: (p.source ?? 'other').replace(/[._]/g, '-') },
            }) ?? '',
        },
        dedupeKey: `cancellation.bulk:${p.cancellationId}:${recipient.id}`,
        excludeAccountIds: p.byAccountId ? [p.byAccountId] : [],
        teacherId: mine[0]!.teacherId,
        lessonStartsAt: new Date(Math.min(...mine.map((l) => new Date(l.startsAt).getTime()))),
      });
    }
  }

  private async cancelled(event: DeliveredEvent): Promise<void> {
    const p = parse(cancelled, event);
    if (p.kind === 'bulk') return; // one summary per recipient instead (NTF-07)
    if (!USER_ROLES.includes(p.byRole as (typeof USER_ROLES)[number])) return; // system texts: M4-06
    const [teacher, by, child, subject] = await Promise.all([
      this.accounts.findById(p.teacherId),
      p.byAccountId ? this.accounts.findById(p.byAccountId) : null,
      p.onBehalfOfStudentId ? this.accounts.findById(p.onBehalfOfStudentId) : null,
      p.subjectId ? this.subjects.findById(p.subjectId) : null,
    ]);
    const base = {
      teacher: name(teacher),
      by: name(by),
      child: name(child),
      subject: subject ? ` (${esc(subject.name)})` : '',
      message: esc(p.message ?? ''),
      lateMark: p.isLate ? this.labels.t('ntf-late-mark') : '',
      view: p.byRole === 'TEACHER' ? 'by-teacher' : p.byRole === 'STUDENT' ? 'by-student' : 'by-parent',
    };
    const startsAt = new Date(p.startsAt);
    const recipients: AccountRow[] = [];
    if (p.byRole === 'TEACHER') recipients.push(...(await this.accounts.findByIds(p.studentIds)));
    else {
      if (teacher) recipients.push(teacher);
      if (p.byRole === 'PARENT' && child) recipients.push(child);
      // CNL-05: the student cancelled → their parents are told too (by the copy rule, as their own message)
      if (p.byRole === 'STUDENT' && p.byAccountId)
        recipients.push(
          ...(await this.accounts.findByIds(
            await this.parentsFor(p.teacherId, p.byAccountId, 'lesson.cancelled'),
          )),
        );
    }
    for (const r of recipients) {
      const isTeacher = r.id === p.teacherId;
      const isParent = !isTeacher && p.byRole === 'STUDENT';
      await this.notifications.schedule({
        type: 'lesson.cancelled',
        recipientId: r.id,
        ...(isTeacher ? {} : { bot: isParent ? ('parent' as const) : ('student' as const) }),
        payload: {
          ...base,
          when: formatInZone(startsAt, r.timezone, WHEN_FORMAT),
          view: isTeacher
            ? base.view
            : isParent
              ? 'by-student-to-parent'
              : p.byRole === 'TEACHER'
                ? 'by-teacher'
                : 'to-student',
        },
        dedupeKey: `lesson.cancelled:${p.lessonId}:${r.id}`,
        teacherId: p.teacherId,
        lessonStartsAt: startsAt,
        excludeAccountIds: p.byAccountId ? [p.byAccountId] : [],
      });
    }
  }

  private async absence(event: DeliveredEvent): Promise<void> {
    const p = parse(absence, event);
    if (p.kind === 'bulk') {
      await this.notifications.cancelByPrefix(`lesson.reminder:${p.lessonId}:`, p.studentId);
      return;
    }
    const [teacher, student, by] = await Promise.all([
      this.accounts.findById(p.teacherId),
      this.accounts.findById(p.studentId),
      p.byAccountId ? this.accounts.findById(p.byAccountId) : null,
    ]);
    // the absent student no longer needs reminders of this lesson (NTF-05)
    await this.notifications.cancelByPrefix(`lesson.reminder:${p.lessonId}:`, p.studentId);
    const base = {
      student: name(student),
      by: name(by),
      message: esc(p.message ?? ''),
      lateMark: p.isLate ? this.labels.t('ntf-late-mark') : '',
      view: p.byRole === 'PARENT' ? 'by-parent' : 'by-student',
    };
    const startsAt = new Date(p.startsAt);
    if (teacher) {
      await this.notifications.schedule({
        type: 'lesson.absence',
        recipientId: teacher.id,
        payload: { ...base, when: formatInZone(startsAt, teacher.timezone, WHEN_FORMAT) },
        dedupeKey: `lesson.absence:${p.lessonId}:${p.studentId}:${teacher.id}`,
      });
    }
    if (p.byRole === 'PARENT' && student) {
      await this.notifications.schedule({
        type: 'lesson.absence',
        recipientId: student.id,
        bot: 'student',
        payload: { ...base, view: 'to-student', when: formatInZone(startsAt, student.timezone, WHEN_FORMAT) },
        dedupeKey: `lesson.absence:${p.lessonId}:${p.studentId}:${student.id}`,
        teacherId: p.teacherId,
        lessonStartsAt: startsAt,
      });
    }
  }
}
