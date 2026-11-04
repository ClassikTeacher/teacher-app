import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { type Actor, assertActive, assertRole } from '@modules/access/actor.js';
import { FeatureService } from '@modules/access/features/feature.service.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { HomeworkQuery } from '@modules/homework/homework.query.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import type { AccountRow } from '@modules/identity/schema.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { linkView } from '@modules/people/links/link.rules.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import type { TeacherStudentRow } from '@modules/people/schema.js';
import { SubjectRepository } from '@modules/people/subject.repository.js';
import { CancellationRepository } from '@modules/schedule/cancellations/cancellation.repository.js';
import { LessonRepository } from '@modules/schedule/lessons/lesson.repository.js';
import { GradeEntryRepository } from './grade-entry.repository.js';
import { JOURNAL_FEATURE, weightedAverage } from './gradebook.rules.js';
import { JournalRepository } from './journal.repository.js';
import { EMPTY_ATTENDANCE, type ReportSnapshot, type ReportSubject } from './report-snapshot.js';
import { ReportRepository } from './report.repository.js';
import type { GradeEntryRow, JournalRow, ReportRow } from './schema.js';
import { customStats, type Range, schoolStats, type ScoredEntry, testStats } from './stats.js';

export const MAX_REPORT_COMMENT_LENGTH = 2000;
/** A report spans at most a year (5.12 «месяц или произвольный диапазон»). */
export const MAX_REPORT_DAYS = 366;

export interface CreateReportInput {
  /** The student card (link) id. */
  linkId: string;
  from: string;
  to: string;
  comment?: string | null;
}

export interface ReportView {
  report: ReportRow;
  snapshot: ReportSnapshot;
  teacher: AccountRow | null;
  student: AccountRow | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * UC-31 (5.12): the teacher builds a report of a student for a period — lessons, attendance, cancellations,
 * homework, the journals — stores it as a snapshot and sends it to the student with a copy to the parents
 * (`report.sent`, NTF-01). Students and parents read sent reports by the read policy of 8.0.
 */
@Injectable()
export class ReportsUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly reports: ReportRepository,
    private readonly journals: JournalRepository,
    private readonly entries: GradeEntryRepository,
    private readonly links: TeacherStudentRepository,
    private readonly family: FamilyLinkRepository,
    private readonly accounts: AccountRepository,
    private readonly subjects: SubjectRepository,
    private readonly lessons: LessonRepository,
    private readonly cancellations: CancellationRepository,
    private readonly homework: HomeworkQuery,
    private readonly features: FeatureService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  /** Builds the snapshot without storing it — the preview of the dialog. */
  async preview(actor: Actor, input: CreateReportInput): Promise<ReportSnapshot> {
    const { link, teacher, student } = await this.ownLink(actor, input.linkId);
    const range = this.normalizeRange(input.from, input.to);
    return this.build(link, teacher, student, range);
  }

  async create(actor: Actor, input: CreateReportInput): Promise<ReportRow> {
    const { link, teacher, student } = await this.ownLink(actor, input.linkId);
    const range = this.normalizeRange(input.from, input.to);
    const comment = this.normalizeComment(input.comment);
    return this.txm.run(async () => {
      const snapshot = await this.build(link, teacher, student, range);
      const row = await this.reports.insert({
        teacherId: link.teacherId,
        studentId: student.id,
        teacherStudentId: link.id,
        periodFrom: range.from,
        periodTo: range.to,
        snapshot: snapshot as unknown as Record<string, unknown>,
        comment,
      });
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: 'TEACHER',
        action: 'report.created',
        entityType: 'report',
        entityId: row.id,
        after: { studentId: student.id, from: range.from, to: range.to, hasComment: comment !== null },
        source: actor.source,
        ip: actor.ip,
      });
      return row;
    });
  }

  /** Sends a draft: the snapshot is frozen as it was built; a sent report cannot be sent twice. */
  async send(actor: Actor, reportId: string, comment?: string | null): Promise<ReportRow> {
    assertRole(actor, 'TEACHER');
    await this.features.assertEnabled(actor.accountId, 'reports');
    const now = this.clock.now();
    return this.txm.run(async () => {
      const row = await this.reports.findById(reportId, { forUpdate: true });
      if (!row || row.teacherId !== actor.accountId) throw AppError.notFound('report', reportId);
      if (row.status === 'sent')
        throw new AppError('CONFLICT', 'The report is already sent', { reason: 'sent' });
      const link = await this.links.findById(row.teacherStudentId);
      if (!link || link.status !== 'active')
        throw new AppError('LINK_NOT_ACTIVE', 'The student is no longer active at this teacher');
      const updated = await this.reports.update(row.id, {
        status: 'sent',
        sentAt: now,
        ...(comment !== undefined ? { comment: this.normalizeComment(comment) } : {}),
      });
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: 'TEACHER',
        action: 'report.sent',
        entityType: 'report',
        entityId: row.id,
        after: { studentId: row.studentId, from: row.periodFrom, to: row.periodTo },
        source: actor.source,
        ip: actor.ip,
      });
      await this.outbox.publish({
        type: 'report.sent',
        aggregateType: 'report',
        aggregateId: row.id,
        payload: { reportId: row.id, teacherId: row.teacherId, studentId: row.studentId },
      });
      return updated;
    });
  }

  /** The teacher's reports about a student (drafts and sent), newest first. */
  async listForTeacher(actor: Actor, linkId: string): Promise<ReportView[]> {
    const { link } = await this.ownLink(actor, linkId, { allowEnded: true });
    const rows = await this.reports.listByPair(link.teacherId, link.studentId!);
    return this.views(rows);
  }

  async teacherReport(actor: Actor, reportId: string): Promise<ReportView> {
    assertRole(actor, 'TEACHER');
    const row = await this.reports.findById(reportId);
    if (!row || row.teacherId !== actor.accountId) throw AppError.notFound('report', reportId);
    return (await this.views([row]))[0]!;
  }

  /** StudentBot → Успеваемость → Отчёты: sent reports at readable links (active or archive). */
  async listForStudent(actor: Actor): Promise<ReportView[]> {
    assertActive(actor);
    if (!actor.roles.includes('STUDENT')) throw AppError.forbidden('Not a student');
    return this.readable(
      actor.accountId,
      actor.status,
      await this.reports.listSentForStudent(actor.accountId),
    );
  }

  async listForChild(actor: Actor, studentId: string): Promise<ReportView[]> {
    assertActive(actor);
    if (!actor.roles.includes('PARENT') || !(await this.family.findActive(actor.accountId, studentId)))
      throw AppError.notFound('child', studentId);
    const child = await this.accounts.findById(studentId);
    if (!child) throw AppError.notFound('child', studentId);
    return this.readable(studentId, child.status, await this.reports.listSentForStudent(studentId));
  }

  /** One sent report for the student or a parent of the student; NOT_FOUND otherwise (8.0). */
  async personReport(actor: Actor, reportId: string): Promise<ReportView> {
    assertActive(actor);
    const row = await this.reports.findById(reportId);
    if (!row || row.status !== 'sent') throw AppError.notFound('report', reportId);
    const isStudent = actor.roles.includes('STUDENT') && row.studentId === actor.accountId;
    const isParent =
      actor.roles.includes('PARENT') &&
      (await this.family.findActive(actor.accountId, row.studentId)) !== null;
    if (!isStudent && !isParent) throw AppError.notFound('report', reportId);
    const student = await this.accounts.findById(row.studentId);
    const list = await this.readable(row.studentId, student?.status ?? 'active', [row]);
    if (list.length === 0) throw AppError.notFound('report', reportId);
    return list[0]!;
  }

  // --- internals ----------------------------------------------------------------------------------

  private async ownLink(
    actor: Actor,
    linkId: string,
    options: { allowEnded?: boolean } = {},
  ): Promise<{ link: TeacherStudentRow; teacher: AccountRow; student: AccountRow }> {
    assertRole(actor, 'TEACHER');
    await this.features.assertEnabled(actor.accountId, 'reports');
    const link = await this.links.findById(linkId);
    if (!link || link.teacherId !== actor.accountId || !link.studentId)
      throw AppError.notFound('student', linkId);
    if (link.status !== 'active' && !(options.allowEnded && link.status === 'ended'))
      throw new AppError('LINK_NOT_ACTIVE', 'The student is not active at this teacher');
    const [teacher, student] = await Promise.all([
      this.accounts.findById(link.teacherId),
      this.accounts.findById(link.studentId),
    ]);
    if (!teacher || !student) throw AppError.notFound('student', linkId);
    return { link, teacher, student };
  }

  private normalizeRange(from: string, to: string): Range {
    if (
      !ISO_DATE.test(from) ||
      !ISO_DATE.test(to) ||
      !DateTime.fromISO(from).isValid ||
      !DateTime.fromISO(to).isValid
    )
      throw AppError.validation('Dates must be YYYY-MM-DD', { reason: 'date_invalid' });
    if (from > to)
      throw AppError.validation('The period end is before its start', { reason: 'range_invalid' });
    if (DateTime.fromISO(to).diff(DateTime.fromISO(from), 'days').days > MAX_REPORT_DAYS)
      throw AppError.validation('The period is too long', { reason: 'range_too_long', max: MAX_REPORT_DAYS });
    return { from, to };
  }

  private normalizeComment(comment: string | null | undefined): string | null {
    const clean = comment?.trim() ?? '';
    if (clean.length > MAX_REPORT_COMMENT_LENGTH)
      throw AppError.validation('The comment is too long', { max: MAX_REPORT_COMMENT_LENGTH });
    return clean || null;
  }

  private async build(
    link: TeacherStudentRow,
    teacher: AccountRow,
    student: AccountRow,
    range: Range,
  ): Promise<ReportSnapshot> {
    const zone = teacher.timezone;
    const interval = {
      start: DateTime.fromISO(range.from, { zone }).startOf('day').toJSDate(),
      end: DateTime.fromISO(range.to, { zone }).startOf('day').plus({ days: 1 }).toJSDate(),
    };
    const lessons = (await this.lessons.listByStudent(student.id, interval)).filter(
      (l) => l.teacherId === link.teacherId,
    );
    const participants = await this.lessons.listParticipantsOf(lessons.map((l) => l.id));
    const attendance = { ...EMPTY_ATTENDANCE };
    const topics: string[] = [];
    let held = 0;
    let notHeld = 0;
    for (const lesson of lessons) {
      if (lesson.status === 'completed') {
        held += 1;
        if (lesson.topic && !topics.includes(lesson.topic)) topics.push(lesson.topic);
        const me = participants.get(lesson.id)?.find((p) => p.studentId === student.id);
        if (me?.attendance) attendance[me.attendance] += 1;
      } else if (lesson.status === 'not_held') notHeld += 1;
    }
    const cancelled = { total: 0, byTeacher: 0, byStudent: 0, byParent: 0, system: 0, late: 0 };
    const acts = await this.cancellations.cancellationsOf(
      lessons.filter((l) => l.status === 'cancelled').map((l) => l.id),
    );
    for (const { item, cancellation } of acts) {
      cancelled.total += 1;
      if (item.isLate) cancelled.late += 1;
      if (cancellation.initiatorRole === 'TEACHER') cancelled.byTeacher += 1;
      else if (cancellation.initiatorRole === 'STUDENT') cancelled.byStudent += 1;
      else if (cancellation.initiatorRole === 'PARENT') cancelled.byParent += 1;
      else cancelled.system += 1;
    }
    const hw = await this.homework.stats(link.teacherId, student.id, interval);
    const journals = (await this.journals.listByLink(link.id)).filter((j) => !j.hidden);
    const features = await this.features.resolve(link.teacherId);
    const live = journals.filter((j) => features.get(JOURNAL_FEATURE[j.type])?.enabled);
    const entries = await this.entries.listByJournals(
      live.map((j) => j.id),
      { from: range.from, to: range.to },
    );
    const byJournal = new Map<string, GradeEntryRow[]>();
    for (const e of entries) byJournal.set(e.journalId, [...(byJournal.get(e.journalId) ?? []), e]);
    const assignmentMarks = entries
      .filter((e) => e.assignmentId && e.valueNumeric !== null && e.valueMax === null)
      .map((e) => ({ value: e.valueNumeric!, weight: e.weight }));
    const subjectRows = await this.subjects.findByIds([...new Set(live.map((j) => j.subjectId))]);
    const scaleValues = new Map(
      (
        await this.journals.findScaleValues([
          ...new Set(entries.map((e) => e.scaleValueId).filter((id): id is string => id !== null)),
        ])
      ).map((v) => [v.id, v]),
    );
    const subjects: ReportSubject[] = subjectRows
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      .map((subject) => {
        const of = (type: JournalRow['type']) =>
          live.find((j) => j.subjectId === subject.id && j.type === type);
        const scored = (j: JournalRow | undefined): ScoredEntry[] =>
          (j ? (byJournal.get(j.id) ?? []) : []).map((e) => ({
            id: e.id,
            date: e.date,
            value: e.valueNumeric ?? 0,
            max: e.valueMax,
            weight: e.weight,
            category: e.category,
            testKindId: e.testKindId,
            scaleValueId: e.scaleValueId,
          }));
        const school = of('school');
        const tests = of('tests');
        const custom = of('custom');
        const customStat = custom
          ? customStats(scored(custom), null, new Map([...scaleValues.values()].map((v) => [v.id, v.weight])))
          : null;
        return {
          subjectId: subject.id,
          name: subject.name,
          school: school ? schoolStats(scored(school), null) : null,
          tests: tests
            ? { ...testStats(scored(tests), null, tests.targetScore), targetPercent: tests.targetScore }
            : null,
          custom: customStat
            ? {
                count: customStat.count,
                values: customStat.byValue.map((v) => {
                  const value = scaleValues.get(v.scaleValueId);
                  return {
                    label: value ? `${value.emoji ? `${value.emoji} ` : ''}${value.label}` : '—',
                    count: v.count,
                  };
                }),
                average: customStat.average,
              }
            : null,
        };
      });
    return {
      version: 1,
      period: range,
      teacher: { id: teacher.id, name: `${teacher.firstName} ${teacher.lastName}`.trim() },
      student: { id: student.id, name: `${student.firstName} ${student.lastName}`.trim() },
      lessons: { held, notHeld, topics, attendance, cancelled },
      homework: {
        assigned: hw.onTime + hw.late + hw.notSubmitted,
        ...hw,
        averageMark: weightedAverage(assignmentMarks),
      },
      subjects,
    };
  }

  private async views(rows: ReportRow[]): Promise<ReportView[]> {
    const ids = [...new Set(rows.flatMap((r) => [r.teacherId, r.studentId]))];
    const accounts = new Map((await this.accounts.findByIds(ids)).map((a) => [a.id, a]));
    return rows.map((report) => ({
      report,
      snapshot: report.snapshot as unknown as ReportSnapshot,
      teacher: accounts.get(report.teacherId) ?? null,
      student: accounts.get(report.studentId) ?? null,
    }));
  }

  /** 8.0: only reports of readable links (active, or the archive after the link ended or the teacher was blocked). */
  private async readable(
    studentId: string,
    studentStatus: AccountRow['status'],
    rows: ReportRow[],
  ): Promise<ReportView[]> {
    const links = new Map(
      (await this.links.listByStudent(studentId, ['active', 'ended'])).map((l) => [l.id, l]),
    );
    const views = await this.views(rows);
    return views.filter((v) => {
      const link = links.get(v.report.teacherStudentId);
      return link && v.teacher && linkView(link, v.teacher.status, studentStatus) !== 'none';
    });
  }
}
