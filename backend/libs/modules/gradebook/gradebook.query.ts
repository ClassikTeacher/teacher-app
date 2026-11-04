import { Injectable } from '@nestjs/common';
import { AppError } from '@shared/errors/app-error.js';
import { type Actor, assertActive, assertRole } from '@modules/access/actor.js';
import { FeatureService } from '@modules/access/features/feature.service.js';
import type { ResolvedFeatures } from '@modules/access/features/rules.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import type { AccountRow } from '@modules/identity/schema.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { linkView, type LinkView } from '@modules/people/links/link.rules.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import type { SubjectRow, TeacherStudentRow } from '@modules/people/schema.js';
import { SubjectRepository } from '@modules/people/subject.repository.js';
import type { EntryLookups } from './format.js';
import { GradeEntryRepository } from './grade-entry.repository.js';
import { JOURNAL_FEATURE, JOURNAL_ORDER } from './gradebook.rules.js';
import { JournalRepository } from './journal.repository.js';
import type { GradeEntryRow, GradeScaleValueRow, JournalRow, JournalType, TestKindRow } from './schema.js';
import {
  customStats,
  type CustomStats,
  type Range,
  schoolStats,
  type SchoolStats,
  type ScoredEntry,
  testDeltas,
  testStats,
  type TestStats,
} from './stats.js';

export interface JournalSummary {
  journal: JournalRow;
  subject: SubjectRow | null;
  /** Confirmed, live records. */
  count: number;
  last: GradeEntryRow | null;
}

export type JournalStats =
  | { type: 'school'; stats: SchoolStats }
  | { type: 'tests'; stats: TestStats }
  | { type: 'custom'; stats: CustomStats };

export interface JournalCard {
  journal: JournalRow;
  subject: SubjectRow | null;
  link: TeacherStudentRow;
  teacher: AccountRow;
  student: AccountRow;
  /** Confirmed records, oldest first (the period filter applies to `stats` only; the list is the tail). */
  entries: GradeEntryRow[];
  /** Teacher only: proposals waiting for a decision. */
  pending: GradeEntryRow[];
  lookups: EntryLookups;
  scaleValues: GradeScaleValueRow[];
  testKinds: TestKindRow[];
  stats: JournalStats;
  /** Tests: change against the previous result per record. */
  deltas: Map<string, number | null>;
  range: Range | null;
}

export interface TeacherJournalsGroup {
  teacher: AccountRow;
  link: TeacherStudentRow;
  view: LinkView;
  journals: JournalSummary[];
}

export interface PendingItem {
  entry: GradeEntryRow;
  journal: JournalRow;
  subject: SubjectRow | null;
  student: AccountRow | null;
  proposer: AccountRow | null;
}

const RECENT_LIMIT = 15;

/** Read side of the gradebook for the three bots and REST: ownership by teacher_id, read policy of 8.0 for students and parents. */
@Injectable()
export class GradebookQuery {
  constructor(
    private readonly journals: JournalRepository,
    private readonly entries: GradeEntryRepository,
    private readonly links: TeacherStudentRepository,
    private readonly family: FamilyLinkRepository,
    private readonly accounts: AccountRepository,
    private readonly subjects: SubjectRepository,
    private readonly features: FeatureService,
  ) {}

  /** Journals of one student at the calling teacher (all three per subject, hidden ones included; features off are dropped). */
  async teacherJournals(
    actor: Actor,
    linkId: string,
  ): Promise<{ link: TeacherStudentRow; student: AccountRow | null; journals: JournalSummary[] }> {
    assertRole(actor, 'TEACHER');
    const link = await this.links.findById(linkId);
    if (!link || link.teacherId !== actor.accountId || !link.studentId)
      throw AppError.notFound('student', linkId);
    const features = await this.features.resolve(actor.accountId);
    const rows = (await this.journals.listByLink(link.id)).filter((j) => this.enabled(features, j.type));
    const student = await this.accounts.findById(link.studentId);
    return { link, student, journals: await this.summaries(rows) };
  }

  /** The teacher's journal screen. */
  async teacherCard(actor: Actor, journalId: string, range: Range | null = null): Promise<JournalCard> {
    assertRole(actor, 'TEACHER');
    const journal = await this.journals.findById(journalId);
    if (!journal || journal.teacherId !== actor.accountId) throw AppError.notFound('journal', journalId);
    await this.features.assertEnabled(actor.accountId, JOURNAL_FEATURE[journal.type]);
    return this.card(journal, range, true);
  }

  /** Proposed marks waiting for the teacher (5.11.2 💡). */
  async pending(actor: Actor): Promise<PendingItem[]> {
    assertRole(actor, 'TEACHER');
    const rows = await this.entries.listPendingByTeacher(actor.accountId);
    const journals = new Map(
      (await this.journals.findByIds(rows.map((e) => e.journalId))).map((j) => [j.id, j]),
    );
    const ids = [...new Set(rows.flatMap((e) => [e.studentId, e.createdBy]))];
    const accounts = new Map((await this.accounts.findByIds(ids)).map((a) => [a.id, a]));
    const subjects = new Map(
      (await this.subjects.findByIds([...new Set([...journals.values()].map((j) => j.subjectId))])).map(
        (s) => [s.id, s],
      ),
    );
    return rows.flatMap((entry) => {
      const journal = journals.get(entry.journalId);
      if (!journal) return [];
      return [
        {
          entry,
          journal,
          subject: subjects.get(journal.subjectId) ?? null,
          student: accounts.get(entry.studentId) ?? null,
          proposer: accounts.get(entry.createdBy) ?? null,
        },
      ];
    });
  }

  async countPending(teacherId: string): Promise<number> {
    return this.entries.countPending(teacherId);
  }

  /** StudentBot → Успеваемость: readable links (active → full, ended or blocked teacher → archive) grouped by teacher. */
  async forStudent(actor: Actor): Promise<TeacherJournalsGroup[]> {
    assertActive(actor);
    if (!actor.roles.includes('STUDENT')) throw AppError.forbidden('Not a student');
    return this.groups(actor.accountId, actor.status, 'student');
  }

  /** ParentBot → Успеваемость ребёнка: the parent must hold an active family link (8.0). */
  async forChild(actor: Actor, studentId: string): Promise<TeacherJournalsGroup[]> {
    assertActive(actor);
    if (!actor.roles.includes('PARENT') || !(await this.family.findActive(actor.accountId, studentId)))
      throw AppError.notFound('child', studentId);
    const child = await this.accounts.findById(studentId);
    if (!child) throw AppError.notFound('child', studentId);
    return this.groups(studentId, child.status, 'parent');
  }

  /** One journal as the student or a parent sees it; NOT_FOUND when hidden or not theirs (8.0, JRN-04). */
  async personCard(actor: Actor, journalId: string, range: Range | null = null): Promise<JournalCard> {
    assertActive(actor);
    const journal = await this.journals.findById(journalId);
    if (!journal) throw AppError.notFound('journal', journalId);
    let side: 'student' | 'parent' | null = null;
    if (actor.roles.includes('STUDENT') && journal.studentId === actor.accountId) side = 'student';
    else if (
      actor.roles.includes('PARENT') &&
      (await this.family.findActive(actor.accountId, journal.studentId))
    )
      side = 'parent';
    if (!side) throw AppError.notFound('journal', journalId);
    const [link, teacher, student] = await Promise.all([
      this.links.findById(journal.teacherStudentId),
      this.accounts.findById(journal.teacherId),
      this.accounts.findById(journal.studentId),
    ]);
    if (!link || !teacher || !student) throw AppError.notFound('journal', journalId);
    if (linkView(link, teacher.status, student.status) === 'none')
      throw AppError.notFound('journal', journalId);
    const features = await this.features.resolve(journal.teacherId);
    if (!this.visibleTo(journal, side, features)) throw AppError.notFound('journal', journalId);
    return this.card(journal, range, false);
  }

  // --- internals ----------------------------------------------------------------------------------

  private enabled(features: ResolvedFeatures, type: JournalType): boolean {
    return features.get(JOURNAL_FEATURE[type])?.enabled ?? false;
  }

  private visibleTo(journal: JournalRow, side: 'student' | 'parent', features: ResolvedFeatures): boolean {
    if (journal.hidden || !this.enabled(features, journal.type)) return false;
    return side === 'student' ? journal.visibleToStudent : journal.visibleToParent;
  }

  private async groups(
    studentId: string,
    studentStatus: AccountRow['status'],
    side: 'student' | 'parent',
  ): Promise<TeacherJournalsGroup[]> {
    const links = await this.links.listByStudent(studentId, ['active', 'ended']);
    const teachers = new Map(
      (await this.accounts.findByIds(links.map((l) => l.teacherId))).map((a) => [a.id, a]),
    );
    const journals = await this.journals.listByLinks(links.map((l) => l.id));
    const out: TeacherJournalsGroup[] = [];
    for (const link of links) {
      const teacher = teachers.get(link.teacherId);
      if (!teacher) continue;
      const view = linkView(link, teacher.status, studentStatus);
      if (view === 'none') continue;
      const features = await this.features.resolve(teacher.id);
      const rows = journals.filter(
        (j) => j.teacherStudentId === link.id && this.visibleTo(j, side, features),
      );
      if (rows.length === 0) continue;
      out.push({ teacher, link, view, journals: await this.summaries(rows) });
    }
    return out;
  }

  private async summaries(rows: JournalRow[]): Promise<JournalSummary[]> {
    const subjects = new Map(
      (await this.subjects.findByIds([...new Set(rows.map((j) => j.subjectId))])).map((s) => [s.id, s]),
    );
    const entries = await this.entries.listByJournals(rows.map((j) => j.id));
    const byJournal = new Map<string, GradeEntryRow[]>();
    for (const e of entries) byJournal.set(e.journalId, [...(byJournal.get(e.journalId) ?? []), e]);
    const sorted = [...rows].sort(
      (a, b) =>
        (subjects.get(a.subjectId)?.position ?? 0) - (subjects.get(b.subjectId)?.position ?? 0) ||
        a.subjectId.localeCompare(b.subjectId) ||
        JOURNAL_ORDER.indexOf(a.type) - JOURNAL_ORDER.indexOf(b.type),
    );
    return sorted.map((journal) => {
      const list = byJournal.get(journal.id) ?? [];
      return {
        journal,
        subject: subjects.get(journal.subjectId) ?? null,
        count: list.length,
        last: list.at(-1) ?? null,
      };
    });
  }

  private async card(journal: JournalRow, range: Range | null, withPending: boolean): Promise<JournalCard> {
    const [subject, link, teacher, student, all, pending] = await Promise.all([
      this.subjects.findById(journal.subjectId),
      this.links.findById(journal.teacherStudentId),
      this.accounts.findById(journal.teacherId),
      this.accounts.findById(journal.studentId),
      this.entries.listByJournal(journal.id),
      withPending ? this.entries.listByJournal(journal.id, { statuses: ['pending'] }) : Promise.resolve([]),
    ]);
    if (!link || !teacher || !student) throw AppError.notFound('journal', journal.id);
    const scaleValues =
      journal.type === 'custom'
        ? await (async () => {
            const scale = await this.journals.findCustomScale(journal.teacherId);
            return scale ? this.journals.listScaleValues(scale.id) : [];
          })()
        : [];
    const referenced = [...new Set(all.map((e) => e.scaleValueId).filter((id): id is string => id !== null))];
    const extra = referenced.filter((id) => !scaleValues.some((v) => v.id === id));
    const allValues =
      extra.length > 0 ? [...scaleValues, ...(await this.journals.findScaleValues(extra))] : scaleValues;
    const testKinds = journal.type === 'tests' ? await this.journals.listTestKinds(journal.teacherId) : [];
    const kindIds = [
      ...new Set([...all, ...pending].map((e) => e.testKindId).filter((id): id is string => id !== null)),
    ];
    const extraKinds = kindIds.filter((id) => !testKinds.some((k) => k.id === id));
    const allKinds =
      extraKinds.length > 0 ? [...testKinds, ...(await this.journals.findTestKinds(extraKinds))] : testKinds;
    const lookups: EntryLookups = {
      scaleValues: new Map(allValues.map((v) => [v.id, v])),
      testKinds: new Map(allKinds.map((k) => [k.id, k])),
    };
    const scored: ScoredEntry[] = all.map((e) => ({
      id: e.id,
      date: e.date,
      value: e.valueNumeric ?? 0,
      max: e.valueMax,
      weight: e.weight,
      category: e.category,
      testKindId: e.testKindId,
      scaleValueId: e.scaleValueId,
    }));
    const stats: JournalStats =
      journal.type === 'school'
        ? { type: 'school', stats: schoolStats(scored, range) }
        : journal.type === 'tests'
          ? { type: 'tests', stats: testStats(scored, range, journal.targetScore) }
          : {
              type: 'custom',
              stats: customStats(
                scored,
                range,
                new Map<string, number | null>(allValues.map((v) => [v.id, v.weight])),
              ),
            };
    return {
      journal,
      subject,
      link,
      teacher,
      student,
      entries: all.slice(-RECENT_LIMIT),
      pending,
      lookups,
      scaleValues: scaleValues.filter((v) => !v.archivedAt),
      testKinds,
      stats,
      deltas: journal.type === 'tests' ? testDeltas(scored) : new Map<string, number | null>(),
      range,
    };
  }
}
