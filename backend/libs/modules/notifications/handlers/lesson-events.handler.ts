import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { Clock, MINUTE_MS } from '@shared/time/clock.js';
import { formatInZone } from '@shared/time/timezone.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import type { AccountRow } from '@modules/identity/schema.js';
import { type DeliveredEvent, DomainEventBus } from '@modules/outbox/event-bus.js';
import { SubjectRepository } from '@modules/people/subject.repository.js';
import { LessonRepository } from '@modules/schedule/lessons/lesson.repository.js';
import type { LessonRow } from '@modules/schedule/schema.js';
import { NotificationPrefsRepository } from '../notification-prefs.repository.js';
import { NotificationService } from '../notification.service.js';
import { NotificationRenderer } from '../render.js';
import { BUTTONS_PAYLOAD_KEY } from '../types.js';

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const uuid = z.string().uuid();
const lessonCreated = z.object({
  lessonId: uuid,
  teacherId: uuid,
  studentIds: z.array(uuid),
  createdVia: z.string().optional(),
});
const participantsChanged = z.object({ lessonId: uuid, added: z.array(uuid), removed: z.array(uuid) });
const memberConflicts = z.object({
  teacherId: uuid,
  studentId: uuid,
  lessons: z.array(z.object({ lessonId: uuid, startsAt: z.string().datetime() })),
});

const seriesMaterialized = z.object({
  seriesId: uuid,
  teacherId: uuid,
  created: z.number().int(),
  ended: z.boolean(),
  conflicts: z.array(z.string().datetime()),
});

const awaitingReport = z.object({ lessonId: uuid, teacherId: uuid, studentIds: z.array(uuid) });
const lessonCompleted = z.object({
  lessonId: uuid,
  teacherId: uuid,
  studentIds: z.array(uuid),
  topic: z.string(),
  sharedComment: z.string(),
  attendance: z.record(z.string(), z.string()),
});
const lessonClosed = z.object({ lessonId: uuid, teacherId: uuid });
const seriesCreated = z.object({
  seriesId: uuid,
  teacherId: uuid,
  studentIds: z.array(uuid),
  weekdays: z.array(z.number().int()),
  startLocal: z.string(),
  durationMin: z.number().int(),
  subjectId: uuid.nullable(),
});
/** LES-07 💡: a second «Как прошло занятие?» two hours after the first one; the digest follows in M4-05. */
export const REPORT_REMINDER_MIN = 120;
const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

function parse<T>(schema: z.ZodType<T>, event: DeliveredEvent): T {
  const result = schema.safeParse(event.payload);
  if (!result.success)
    throw new UnrecoverableError(`malformed ${event.type} payload: ${result.error.message}`);
  return result.data;
}

/** 5.13.3 defaults: 24 hours and 1 hour before the lesson; personal choices arrive with M4-05. */
export const DEFAULT_REMINDER_OFFSETS_MIN = [24 * 60, 60] as const;
const WHEN_FORMAT = 'ccc dd.MM HH:mm';

/**
 * Lesson events → messages (5.13.1): `lesson.created` to every student (UC-14 step 4) with reminders planned per
 * participant and for the teacher (UC-37, keys `lesson.reminder:<lessonId>:<offset>:<version>:<recipient>`,
 * NTF-08); joining a group lesson later → `lesson.participants_changed`; `lesson.member_conflicts` → teacher.
 */
@Injectable()
export class LessonEventsHandler implements OnModuleInit {
  private readonly labels = new NotificationRenderer();

  constructor(
    private readonly bus: DomainEventBus,
    private readonly accounts: AccountRepository,
    private readonly subjects: SubjectRepository,
    private readonly lessons: LessonRepository,
    private readonly notifications: NotificationService,
    private readonly prefs: NotificationPrefsRepository,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.bus.on('lesson.created', (e) => this.created(e));
    this.bus.on('lesson.participants_changed', (e) => this.participantsChanged(e));
    this.bus.on('lesson.member_conflicts', (e) => this.memberConflicts(e));
    this.bus.on('series.materialized', (e) => this.seriesMaterialized(e));
    this.bus.on('series.created', (e) => this.seriesCreated(e));
    this.bus.on('lesson.awaiting_report', (e) => this.awaitingReport(e));
    this.bus.on('lesson.completed', (e) => this.completed(e));
    this.bus.on('lesson.not_held', (e) => this.closed(e));
    this.bus.on('lesson.cancelled', (e) => this.closed(e));
    this.bus.on('lesson.rescheduled', (e) => this.rescheduled(e));
  }

  /** NTF-05: a moved lesson gets its reminders planned afresh (keyed by the new version). */
  private async rescheduled(event: DeliveredEvent): Promise<void> {
    const p = parse(lessonClosed, event);
    const lesson = await this.lessons.findById(p.lessonId);
    await this.notifications.cancelByPrefix(`lesson.reminder:${p.lessonId}:`);
    if (!lesson || lesson.status !== 'scheduled') return;
    const base = await this.describe(lesson);
    const current = (await this.lessons.listParticipants(lesson.id)).map((x) => x.studentId);
    await this.planReminders(lesson, base, [...current, lesson.teacherId]);
  }

  /** 5.5.6 / NTF-07: one «Регулярные занятия» message per student instead of one per instance. */
  private async seriesCreated(event: DeliveredEvent): Promise<void> {
    const p = parse(seriesCreated, event);
    const [teacher, subject] = await Promise.all([
      this.accounts.findById(p.teacherId),
      p.subjectId ? this.subjects.findById(p.subjectId) : null,
    ]);
    const days = p.weekdays.map((d) => this.labels.t(`weekday-${WEEKDAY_KEYS[d - 1] ?? 'mon'}`)).join(', ');
    for (const student of await this.accounts.findByIds(p.studentIds)) {
      await this.notifications.schedule({
        type: 'series.created',
        recipientId: student.id,
        bot: 'student',
        payload: {
          days: esc(days),
          time: p.startLocal.slice(0, 5),
          duration: p.durationMin,
          subject: esc(subject?.name ?? '—'),
          teacher: esc(teacher ? `${teacher.firstName} ${teacher.lastName}`.trim() : '—'),
        },
        dedupeKey: `series.created:${p.seriesId}:${student.id}`,
        teacherId: p.teacherId,
      });
    }
  }

  /** LES-06: «Как прошло занятие с Петей?» with the four buttons, plus the 2-hour reminder (LES-07). */
  private async awaitingReport(event: DeliveredEvent): Promise<void> {
    const p = parse(awaitingReport, event);
    const lesson = await this.lessons.findById(p.lessonId);
    if (!lesson || lesson.status !== 'awaiting_report') return;
    const [teacher, students] = await Promise.all([
      this.accounts.findById(p.teacherId),
      this.accounts.findByIds(p.studentIds),
    ]);
    if (!teacher) return;
    const who = esc(students.map((s) => `${s.firstName} ${s.lastName}`.trim()).join(', ') || '—');
    const button = (key: string, action: string) => ({
      text: this.labels.t(key),
      data: `s:today:rep:${lesson.id}:${action}`,
    });
    const buttons = [
      ...(lesson.plannedTopic ? [button('btn-topic-as-planned', 'planned')] : []),
      button('btn-enter-topic', 'topic'),
      ...(lesson.groupId ? [] : [button('btn-student-no-show', 'noshow')]), // a group marks absences one by one
      button('btn-report-later', 'later'),
    ];
    const payload = { who, when: this.when(lesson, teacher), [BUTTONS_PAYLOAD_KEY]: buttons };
    await this.notifications.schedule({
      type: 'lesson.report_required',
      recipientId: p.teacherId,
      payload,
      dedupeKey: `lesson.report_required:${lesson.id}`,
    });
    await this.notifications.schedule({
      type: 'lesson.report_required',
      recipientId: p.teacherId,
      payload,
      dedupeKey: `lesson.report_reminder:${lesson.id}`,
      // two hours after the ask, not after the lesson: a late sweep must not deliver both at once
      dueAt: new Date(
        Math.max(lesson.endsAt.getTime(), this.clock.now().getTime()) + REPORT_REMINDER_MIN * MINUTE_MS,
      ),
    });
    // the teacher may have reported meanwhile (the status read above is not locked): nothing to ask then
    const fresh = await this.lessons.findById(lesson.id);
    if (fresh && fresh.status !== 'awaiting_report') await this.dropReportAsks(lesson.id);
  }

  private async dropReportAsks(lessonId: string): Promise<void> {
    await this.notifications.cancelByPrefix(`lesson.report_required:${lessonId}`);
    await this.notifications.cancelByPrefix(`lesson.report_reminder:${lessonId}`);
  }

  /** LES-08: «Итоги занятия» to every student; the pending report reminder is dropped. */
  private async completed(event: DeliveredEvent): Promise<void> {
    const p = parse(lessonCompleted, event);
    await this.dropReportAsks(p.lessonId);
    const lesson = await this.lessons.findById(p.lessonId);
    if (!lesson) return;
    const base = await this.describe(lesson);
    for (const student of await this.accounts.findByIds(p.studentIds)) {
      await this.notifications.schedule({
        type: 'lesson.summary',
        recipientId: student.id,
        bot: 'student',
        payload: {
          ...base,
          when: this.when(lesson, student),
          topic: esc(p.topic),
          comment: esc(p.sharedComment),
          attendance: p.attendance[student.id] ?? 'present',
        },
        dedupeKey: `lesson.summary:${lesson.id}:${student.id}`,
        teacherId: lesson.teacherId,
        lessonStartsAt: lesson.startsAt,
      });
    }
  }

  /** `not_held` and `cancelled`: nothing more to remind about (NTF-05). */
  private async closed(event: DeliveredEvent): Promise<void> {
    const p = parse(lessonClosed, event);
    await this.dropReportAsks(p.lessonId);
    await this.notifications.cancelByPrefix(`lesson.reminder:${p.lessonId}:`);
  }

  /** UC-39: instances that collided are listed with "перенести / пропустить" as the teacher's choice (M4). */
  private async seriesMaterialized(event: DeliveredEvent): Promise<void> {
    const p = parse(seriesMaterialized, event);
    const teacher = await this.accounts.findById(p.teacherId);
    if (!teacher) return;
    const dates = p.conflicts.map((d) => formatInZone(new Date(d), teacher.timezone, WHEN_FORMAT)).join(', ');
    await this.notifications.schedule({
      type: 'series.conflicts',
      recipientId: p.teacherId,
      payload: { created: p.created, dates: esc(dates || '—'), ended: p.ended ? 'yes' : 'no' },
      dedupeKey: `series.conflicts:${event.id}`,
    });
  }

  private async created(event: DeliveredEvent): Promise<void> {
    const p = parse(lessonCreated, event);
    const lesson = await this.lessons.findById(p.lessonId);
    if (!lesson || lesson.status !== 'scheduled') return; // cancelled before the worker got here
    const base = await this.describe(lesson);
    // 5.5.5 step 3: a self-booked lesson is announced to the teacher with «ОК» and «Отменить»
    if (p.createdVia === 'student_booking' || p.createdVia === 'booking_accepted') {
      const [teacher, student] = await Promise.all([
        this.accounts.findById(p.teacherId),
        this.accounts.findById(p.studentIds[0] ?? ''),
      ]);
      if (teacher && p.createdVia === 'student_booking') {
        await this.notifications.schedule({
          type: 'lesson.created',
          recipientId: teacher.id,
          payload: {
            ...base,
            view: 'booked',
            student: esc(student ? `${student.firstName} ${student.lastName}`.trim() : '—'),
            when: this.when(lesson, teacher),
            [BUTTONS_PAYLOAD_KEY]: [
              { text: this.labels.t('btn-move-ok'), data: `s:today:lesson:${lesson.id}` },
              { text: this.labels.t('btn-lesson-cancel'), data: `s:today:cancel:${lesson.id}` },
            ],
          },
          dedupeKey: `lesson.created:${lesson.id}:${teacher.id}`,
        });
      }
    }
    // instances of a series are announced once per series (`series.created`), not one by one (NTF-07);
    // a self-booked lesson is confirmed to the student by the booking itself (or by `booking.decided`)
    const announce =
      p.createdVia === 'series' || p.createdVia === 'student_booking' || p.createdVia === 'booking_accepted'
        ? []
        : await this.accounts.findByIds(p.studentIds);
    for (const student of announce) {
      const studentId = student.id;
      await this.notifications.schedule({
        type: 'lesson.created',
        recipientId: studentId,
        bot: 'student',
        payload: { ...base, when: this.when(lesson, student) },
        dedupeKey: `lesson.created:${lesson.id}:${studentId}`,
        teacherId: lesson.teacherId,
        lessonStartsAt: lesson.startsAt,
      });
    }
    await this.planReminders(lesson, base, [...p.studentIds, p.teacherId]);
  }

  private async participantsChanged(event: DeliveredEvent): Promise<void> {
    const p = parse(participantsChanged, event);
    const lesson = await this.lessons.findById(p.lessonId);
    if (!lesson || lesson.status !== 'scheduled') return;
    const base = await this.describe(lesson);
    for (const student of await this.accounts.findByIds(p.added)) {
      const studentId = student.id;
      await this.notifications.schedule({
        type: 'lesson.participants_changed',
        recipientId: studentId,
        bot: 'student',
        payload: { ...base, when: this.when(lesson, student) },
        dedupeKey: `lesson.participants_changed:${lesson.id}:${studentId}:${lesson.version}`,
        teacherId: lesson.teacherId,
        lessonStartsAt: lesson.startsAt,
      });
    }
    // the version changed: reminders of the previous version are dropped for everyone (people who left included)
    // and planned again for the current participants and the teacher, keyed by the new version (NTF-05, NTF-08)
    await this.notifications.cancelByPrefix(`lesson.reminder:${lesson.id}:`);
    const current = (await this.lessons.listParticipants(lesson.id)).map((x) => x.studentId);
    await this.planReminders(lesson, base, [...current, lesson.teacherId]);
  }

  private async memberConflicts(event: DeliveredEvent): Promise<void> {
    const p = parse(memberConflicts, event);
    const sourceEventId = (event.payload as { sourceEventId?: unknown }).sourceEventId;
    const key = typeof sourceEventId === 'string' ? sourceEventId : event.id;
    const [teacher, student] = await Promise.all([
      this.accounts.findById(p.teacherId),
      this.accounts.findById(p.studentId),
    ]);
    if (!teacher || !student) return;
    const dates = p.lessons
      .map((l) => formatInZone(new Date(l.startsAt), teacher.timezone, WHEN_FORMAT))
      .join(', ');
    await this.notifications.schedule({
      type: 'lesson.member_conflicts',
      recipientId: p.teacherId,
      payload: { student: esc(`${student.firstName} ${student.lastName}`.trim()), dates: esc(dates) },
      dedupeKey: `lesson.member_conflicts:${key}`, // re-delivery of the same membership event: one message
    });
  }

  /** Subject, teacher name and duration — the parts of the text that do not depend on the recipient. */
  private async describe(lesson: LessonRow): Promise<Record<string, string | number>> {
    const [teacher, subject] = await Promise.all([
      this.accounts.findById(lesson.teacherId),
      lesson.subjectId ? this.subjects.findById(lesson.subjectId) : null,
    ]);
    return {
      teacher: esc(teacher ? `${teacher.firstName} ${teacher.lastName}`.trim() : '—'),
      subject: esc(subject?.name ?? '—'),
      duration: Math.round((lesson.endsAt.getTime() - lesson.startsAt.getTime()) / MINUTE_MS),
    };
  }

  private when(lesson: LessonRow, recipient: AccountRow): string {
    return formatInZone(lesson.startsAt, recipient.timezone, WHEN_FORMAT);
  }

  /** One reminder per offset and recipient; offsets already in the past are skipped (NTF-05 handles changes). */
  private async planReminders(
    lesson: LessonRow,
    base: Record<string, string | number>,
    recipientIds: readonly string[],
  ): Promise<void> {
    const now = this.clock.now();
    const recipients = await this.accounts.findByIds([...new Set(recipientIds)]);
    const profiles = await this.prefs.profiles(recipients.map((r) => r.id)); // 5.13.3: personal intervals
    const studentNames = recipients
      .filter((r) => r.id !== lesson.teacherId)
      .map((r) => esc(`${r.firstName} ${r.lastName}`.trim()))
      .join(', ');
    for (const recipient of recipients) {
      const recipientId = recipient.id;
      const isTeacher = recipientId === lesson.teacherId;
      // the teacher is reminded with whom, the student with which teacher
      const withWhom = isTeacher
        ? studentNames
          ? ` · ${studentNames}`
          : ''
        : ` · ${String(base['teacher'])}`;
      const offsets = profiles.get(recipientId)?.reminderOffsetsMin ?? DEFAULT_REMINDER_OFFSETS_MIN;
      for (const offset of offsets) {
        const dueAt = new Date(lesson.startsAt.getTime() - offset * MINUTE_MS);
        if (dueAt.getTime() <= now.getTime()) continue;
        // 5.13.3: «Отменить» right on the reminder (UC-20 step 1); «Перенести» joins in M4-03
        const cancelButton = {
          text: this.labels.t(lesson.groupId && !isTeacher ? 'btn-lesson-absence' : 'btn-lesson-cancel'),
          data: isTeacher ? `s:today:cancel:${lesson.id}` : `s:schedule:cancel:${lesson.id}`,
        };
        const moveButton = {
          text: this.labels.t('btn-lesson-move'),
          data: isTeacher ? `s:today:move:${lesson.id}` : `s:schedule:move:${lesson.id}`,
        };
        // a group lesson is moved by the teacher only; students report absence instead (CNL-03)
        const buttons = isTeacher || !lesson.groupId ? [cancelButton, moveButton] : [cancelButton];
        await this.notifications.schedule({
          type: 'lesson.reminder',
          recipientId,
          ...(isTeacher ? {} : { bot: 'student' as const }),
          payload: {
            ...base,
            when: this.when(lesson, recipient),
            withWhom,
            [BUTTONS_PAYLOAD_KEY]: buttons,
          },
          dedupeKey: `lesson.reminder:${lesson.id}:${offset}:${lesson.version}:${recipientId}`,
          dueAt,
          keepTime: true, // a reminder after the lesson is useless (NTF-06 exempt)
          teacherId: lesson.teacherId,
          lessonStartsAt: lesson.startsAt,
        });
      }
    }
  }
}
