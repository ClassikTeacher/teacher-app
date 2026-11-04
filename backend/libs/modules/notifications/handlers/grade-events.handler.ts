import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { Clock } from '@shared/time/clock.js';
import { entryKindText, entryValueText } from '@modules/gradebook/format.js';
import { GradeEntryRepository } from '@modules/gradebook/grade-entry.repository.js';
import { GRADE_DIGEST_THRESHOLD } from '@modules/gradebook/gradebook.rules.js';
import { JournalRepository } from '@modules/gradebook/journal.repository.js';
import { isReportSnapshot } from '@modules/gradebook/report-snapshot.js';
import { renderReport } from '@modules/gradebook/report-text.js';
import { ReportRepository } from '@modules/gradebook/report.repository.js';
import { JOURNAL_TYPES, type GradeEntryRow, type JournalRow } from '@modules/gradebook/schema.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { type DeliveredEvent, DomainEventBus } from '@modules/outbox/event-bus.js';
import { SubjectRepository } from '@modules/people/subject.repository.js';
import { NotificationService } from '../notification.service.js';
import { NotificationRenderer } from '../render.js';
import { BUTTONS_PAYLOAD_KEY } from '../types.js';

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const uuid = z.string().uuid();
const entryEvent = z.object({
  entryId: uuid,
  journalId: uuid,
  teacherId: uuid,
  studentId: uuid,
  type: z.enum(JOURNAL_TYPES),
  subjectId: uuid,
  source: z.enum(['teacher', 'student', 'parent']),
  createdBy: uuid,
});
const reportEvent = z.object({ reportId: uuid, teacherId: uuid, studentId: uuid });

function parse<T>(schema: z.ZodType<T>, event: DeliveredEvent): T {
  const result = schema.safeParse(event.payload);
  if (!result.success)
    throw new UnrecoverableError(`malformed ${event.type} payload: ${result.error.message}`);
  return result.data;
}

const DATE = 'dd.MM';

/**
 * Gradebook messages (5.11, 5.13.1): `grade.added` to the student with the copy rule (NTF-01), aggregated into
 * one `grade.digest` a day once a teacher records more than N marks for the student (NTF-07 💡); a proposed mark
 * (UC-30) goes to the teacher with «Подтвердить / Отклонить»; a rejected proposal goes back to its author.
 */
@Injectable()
export class GradeEventsHandler implements OnModuleInit {
  private readonly labels = new NotificationRenderer();

  constructor(
    private readonly bus: DomainEventBus,
    private readonly accounts: AccountRepository,
    private readonly subjects: SubjectRepository,
    private readonly journals: JournalRepository,
    private readonly entries: GradeEntryRepository,
    private readonly reports: ReportRepository,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.bus.on('grade.added', (e) => this.added(e));
    this.bus.on('grade.proposed', (e) => this.proposed(e));
    this.bus.on('grade.rejected', (e) => this.rejected(e));
    this.bus.on('grade.removed', (e) => this.removed(e));
    this.bus.on('report.sent', (e) => this.reportSent(e));
  }

  /** UC-31 (5.12): the report itself as the message, to the student with a copy to the parents (NTF-01). */
  private async reportSent(event: DeliveredEvent): Promise<void> {
    const p = parse(reportEvent, event);
    const row = await this.reports.findById(p.reportId);
    if (!row || row.status !== 'sent' || !isReportSnapshot(row.snapshot)) return;
    const body = renderReport((key, vars) => this.labels.t(key, 'ru', vars), row.snapshot, row.comment);
    await this.notifications.schedule({
      type: 'report.sent',
      recipientId: row.studentId,
      bot: 'student',
      payload: {
        body,
        teacher: esc(row.snapshot.teacher.name),
        [BUTTONS_PAYLOAD_KEY]: [{ text: this.labels.t('btn-open-report'), data: `s:progress:r:${row.id}` }],
      },
      dedupeKey: `report.sent:${row.id}`,
      teacherId: row.teacherId,
    });
  }

  private async load(event: DeliveredEvent) {
    const p = parse(entryEvent, event);
    const [entry, journal] = await Promise.all([
      this.entries.findById(p.entryId),
      this.journals.findById(p.journalId),
    ]);
    if (!entry || !journal || entry.deletedAt) return null;
    const [teacher, student, subject] = await Promise.all([
      this.accounts.findById(journal.teacherId),
      this.accounts.findById(journal.studentId),
      this.subjects.findById(journal.subjectId),
    ]);
    if (!teacher || !student) return null;
    return { p, entry, journal, teacher, student, subject };
  }

  private async describe(entry: GradeEntryRow, journal: JournalRow): Promise<Record<string, string>> {
    const [values, kinds] = await Promise.all([
      entry.scaleValueId ? this.journals.findScaleValues([entry.scaleValueId]) : [],
      entry.testKindId ? this.journals.findTestKinds([entry.testKindId]) : [],
    ]);
    const lookups = {
      scaleValues: new Map(values.map((v) => [v.id, v])),
      testKinds: new Map(kinds.map((k) => [k.id, k])),
    };
    const kindRaw = entryKindText(entry, journal.type, lookups);
    const kind =
      journal.type === 'school'
        ? this.labels.t(`grade-category-${kindRaw ?? 'current'}`)
        : esc(kindRaw ?? '');
    // Fluent variants cannot match an empty string, so optional fragments are built here (T-11: escaped once)
    return {
      value: esc(entryValueText(entry, journal.type, lookups)),
      kind,
      kindLine: kind ? ` · ${kind}` : '',
      date: DateTime.fromISO(entry.date).toFormat(DATE),
      comment: esc(entry.comment ?? ''),
      commentLine: entry.comment ? `\n${this.labels.t('grade-comment-label')}: ${esc(entry.comment)}` : '',
      type: journal.type,
    };
  }

  /** The student hears about a confirmed mark; beyond N a day they get one digest instead (NTF-07). */
  private async added(event: DeliveredEvent): Promise<void> {
    const loaded = await this.load(event);
    if (!loaded || loaded.entry.status !== 'confirmed') return;
    const { entry, journal, teacher, student, subject } = loaded;
    if (journal.hidden || !journal.visibleToStudent) return; // JRN-04: an invisible journal stays silent
    const now = this.clock.now();
    const local = DateTime.fromJSDate(now, { zone: student.timezone });
    const day = { from: local.startOf('day').toJSDate(), to: local.endOf('day').toJSDate() };
    const today = await this.entries.countConfirmedCreatedBetween(
      journal.teacherId,
      journal.studentId,
      day.from,
      day.to,
    );
    const base = {
      teacher: esc(`${teacher.firstName} ${teacher.lastName}`.trim()),
      subject: esc(subject?.name ?? '—'),
      [BUTTONS_PAYLOAD_KEY]: [
        { text: this.labels.t('btn-open-journal'), data: `s:progress:j:${journal.id}` },
      ],
    };
    if (today > GRADE_DIGEST_THRESHOLD) {
      await this.notifications.schedule({
        type: 'grade.digest',
        recipientId: student.id,
        bot: 'student',
        payload: base,
        dedupeKey: `grade.digest:${journal.teacherId}:${student.id}:${local.toISODate()}`,
        teacherId: journal.teacherId,
      });
      return;
    }
    await this.notifications.schedule({
      type: 'grade.added',
      recipientId: student.id,
      bot: 'student',
      payload: { ...base, ...(await this.describe(entry, journal)), source: entry.source },
      dedupeKey: `grade.added:${entry.id}:v${entry.version}`,
      teacherId: journal.teacherId,
    });
  }

  /** UC-30: «Петя сообщил отметку …» to the teacher with the decision buttons. */
  private async proposed(event: DeliveredEvent): Promise<void> {
    const loaded = await this.load(event);
    if (!loaded || loaded.entry.status !== 'pending') return;
    const { entry, journal, teacher, student, subject } = loaded;
    const proposer = entry.createdBy === student.id ? student : await this.accounts.findById(entry.createdBy);
    await this.notifications.schedule({
      type: 'grade.proposed',
      recipientId: teacher.id,
      payload: {
        ...(await this.describe(entry, journal)),
        student: esc(`${student.firstName} ${student.lastName}`.trim()),
        by: esc(proposer ? `${proposer.firstName} ${proposer.lastName}`.trim() : '—'),
        source: entry.source,
        subject: esc(subject?.name ?? '—'),
        [BUTTONS_PAYLOAD_KEY]: [
          { text: this.labels.t('btn-grade-confirm'), data: `s:journals:ok:${entry.id}` },
          { text: this.labels.t('btn-grade-reject'), data: `s:journals:no:${entry.id}` },
        ],
      },
      dedupeKey: `grade.proposed:${entry.id}`,
    });
  }

  /** The author of a rejected proposal learns about it; the student is never told about a parent's attempt. */
  private async rejected(event: DeliveredEvent): Promise<void> {
    const loaded = await this.load(event);
    if (!loaded) return;
    const { entry, journal, teacher, subject } = loaded;
    await this.notifications.cancelByPrefix(`grade.proposed:${entry.id}`);
    await this.notifications.schedule({
      type: 'grade.rejected',
      recipientId: entry.createdBy,
      payload: {
        ...(await this.describe(entry, journal)),
        teacher: esc(`${teacher.firstName} ${teacher.lastName}`.trim()),
        subject: esc(subject?.name ?? '—'),
      },
      dedupeKey: `grade.rejected:${entry.id}`,
      teacherId: journal.teacherId,
    });
  }

  private async removed(event: DeliveredEvent): Promise<void> {
    const p = parse(entryEvent, event);
    await this.notifications.cancelByPrefix(`grade.added:${p.entryId}:`);
    await this.notifications.cancelByPrefix(`grade.proposed:${p.entryId}`);
  }
}
