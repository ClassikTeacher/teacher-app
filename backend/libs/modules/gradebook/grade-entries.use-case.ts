import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { type Actor, assertActive, assertRole, primaryRole } from '@modules/access/actor.js';
import { FeatureService } from '@modules/access/features/feature.service.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { FileRepository } from '@modules/files/file.repository.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { linkView } from '@modules/people/links/link.rules.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { GradeEntryRepository, type NewGradeEntry } from './grade-entry.repository.js';
import {
  DEFAULT_CATEGORY,
  JOURNAL_FEATURE,
  MAX_PENDING_PER_JOURNAL,
  normalizeComment,
  normalizeEntryDate,
  normalizeSchoolValue,
  normalizeTestScore,
  normalizeWeight,
} from './gradebook.rules.js';
import { JournalRepository } from './journal.repository.js';
import {
  type EntrySource,
  type GradeEntryRow,
  type JournalRow,
  type JournalType,
  PLATFORM_SCALE_ID,
  SCHOOL_CATEGORIES,
  type SchoolCategory,
  type TestParts,
} from './schema.js';

export interface GradeValueInput {
  /** School mark or test score. */
  value?: number | null;
  /** Tests: the maximum (💡 100 by default) and the parts. */
  max?: number | null;
  parts?: TestParts | null;
  /** Custom journal: the scale value. */
  scaleValueId?: string | null;
  /** School: the category (current by default). Tests: the kind. */
  category?: SchoolCategory | null;
  testKindId?: string | null;
  weight?: number | null;
  comment?: string | null;
  /** Tests: a draft file uploaded by the teacher (the scanned sheet); attached on save. */
  fileId?: string | null;
}

export interface AddEntryInput extends GradeValueInput {
  journalId: string;
  /** ISO date in the teacher's zone; today by default. */
  date?: string | null;
  lessonId?: string | null;
  assignmentId?: string | null;
}

export interface ProposeEntryInput {
  journalId: string;
  value: number;
  category?: SchoolCategory | null;
  date?: string | null;
  comment?: string | null;
  /** A parent proposes for this child. */
  studentId?: string;
}

export interface EntryEvent {
  entryId: string;
  journalId: string;
  teacherId: string;
  studentId: string;
  type: JournalType;
  subjectId: string;
  source: EntrySource;
  createdBy: string;
}

const SNAPSHOT_FIELDS = [
  'date',
  'category',
  'testKindId',
  'valueNumeric',
  'valueMax',
  'scaleValueId',
  'parts',
  'weight',
  'comment',
  'lessonId',
  'assignmentId',
  'fileId',
  'status',
] as const;

export function entrySnapshot(entry: GradeEntryRow): Record<string, unknown> {
  return Object.fromEntries(SNAPSHOT_FIELDS.map((k) => [k, entry[k]]));
}

/**
 * UC-29 / UC-30 (5.11): records of the three journals. The teacher adds, edits and deletes records (history,
 * JRN-05); a student or a parent proposes a school mark that waits for the teacher — or is accepted at once by
 * the teacher's setting (5.11.2 💡). Every write checks ownership, the active link and the journal feature (8.0,
 * 5.3.3) and lands in the audit (AUD-01 «правки журналов») and the outbox for notifications.
 */
@Injectable()
export class GradeEntriesUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly journals: JournalRepository,
    private readonly entries: GradeEntryRepository,
    private readonly links: TeacherStudentRepository,
    private readonly family: FamilyLinkRepository,
    private readonly accounts: AccountRepository,
    private readonly profiles: TeacherProfileRepository,
    private readonly files: FileRepository,
    private readonly features: FeatureService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  /** The journal of the teacher and student for a subject and type, or NOT_FOUND (lesson report, review). */
  async journalFor(
    actor: Actor,
    studentId: string,
    subjectId: string,
    type: JournalType,
  ): Promise<JournalRow> {
    assertRole(actor, 'TEACHER');
    const link = await this.links.findByPair(actor.accountId, studentId);
    if (!link || link.status !== 'active')
      throw new AppError('LINK_NOT_ACTIVE', 'The student is not active at this teacher');
    const row = await this.journals.findByLinkSubjectType(link.id, subjectId, type);
    if (!row) throw AppError.notFound('journal');
    return row;
  }

  /** UC-29: the teacher records a mark (from the lesson report, the review of a submission, or by hand). */
  async add(actor: Actor, input: AddEntryInput): Promise<GradeEntryRow> {
    assertRole(actor, 'TEACHER');
    const now = this.clock.now();
    return this.txm.run(async () => {
      const journal = await this.ownJournal(actor, input.journalId);
      const teacher = await this.accounts.findById(actor.accountId);
      const values = await this.normalizeValues(journal, input);
      const fileId = await this.attachFile(actor, journal, input.fileId, now);
      const row = await this.entries.insert({
        journalId: journal.id,
        teacherId: journal.teacherId,
        studentId: journal.studentId,
        date: normalizeEntryDate(input.date ?? this.today(teacher?.timezone), this.today(teacher?.timezone)),
        ...values,
        lessonId: input.lessonId ?? null,
        assignmentId: input.assignmentId ?? null,
        fileId,
        source: 'teacher',
        createdBy: actor.accountId,
        status: 'confirmed',
      });
      await this.entries.addHistory({
        entryId: row.id,
        changedBy: actor.accountId,
        action: 'created',
        before: null,
        after: entrySnapshot(row),
        at: now,
      });
      await this.record(actor, 'grade.added', row, null);
      await this.publish('grade.added', row, journal);
      return row;
    });
  }

  /** JRN-05: the teacher edits a record; the previous state goes to the history. */
  async update(
    actor: Actor,
    entryId: string,
    patch: GradeValueInput & { date?: string | null },
  ): Promise<GradeEntryRow> {
    assertRole(actor, 'TEACHER');
    const now = this.clock.now();
    return this.txm.run(async () => {
      const entry = await this.ownEntry(actor, entryId);
      const journal = await this.ownJournal(actor, entry.journalId);
      const teacher = await this.accounts.findById(actor.accountId);
      const merged: GradeValueInput = {
        value: patch.value ?? entry.valueNumeric,
        max: patch.max ?? entry.valueMax,
        parts: patch.parts === undefined ? entry.parts : patch.parts,
        scaleValueId: patch.scaleValueId ?? entry.scaleValueId,
        category: patch.category ?? entry.category,
        testKindId: patch.testKindId ?? entry.testKindId,
        weight: patch.weight ?? entry.weight,
        comment: patch.comment === undefined ? entry.comment : patch.comment,
      };
      const values = await this.normalizeValues(journal, merged);
      const date = patch.date ? normalizeEntryDate(patch.date, this.today(teacher?.timezone)) : entry.date;
      const fileId =
        patch.fileId === undefined ? entry.fileId : await this.attachFile(actor, journal, patch.fileId, now);
      const before = entrySnapshot(entry);
      const updated = await this.entries.update(entry.id, { ...values, date, fileId });
      await this.entries.addHistory({
        entryId: entry.id,
        changedBy: actor.accountId,
        action: 'updated',
        before,
        after: entrySnapshot(updated),
        at: now,
      });
      await this.record(actor, 'grade.updated', updated, before);
      await this.publish('grade.updated', updated, journal);
      return updated;
    });
  }

  /** JRN-05: a soft delete that keeps the record in the history. */
  async remove(actor: Actor, entryId: string): Promise<GradeEntryRow> {
    assertRole(actor, 'TEACHER');
    const now = this.clock.now();
    return this.txm.run(async () => {
      const entry = await this.ownEntry(actor, entryId);
      const journal = await this.ownJournal(actor, entry.journalId);
      const removed = await this.entries.update(entry.id, { deletedAt: now });
      await this.entries.addHistory({
        entryId: entry.id,
        changedBy: actor.accountId,
        action: 'deleted',
        before: entrySnapshot(entry),
        after: null,
        at: now,
      });
      await this.record(actor, 'grade.removed', removed, entrySnapshot(entry));
      await this.publish('grade.removed', removed, journal);
      return removed;
    });
  }

  /**
   * UC-30 (5.11.2 💡): a student, or a parent for a child, reports a school mark. The journal must be visible
   * to them (JRN-04) and the link active; the record waits for the teacher unless the teacher accepts such
   * marks at once.
   */
  async propose(actor: Actor, input: ProposeEntryInput): Promise<GradeEntryRow> {
    assertActive(actor);
    const now = this.clock.now();
    return this.txm.run(async () => {
      const journal = await this.journals.findById(input.journalId);
      if (!journal) throw AppError.notFound('journal', input.journalId);
      const source = await this.proposerRole(actor, journal, input.studentId);
      if (journal.type !== 'school')
        throw AppError.validation('Only school marks can be reported', { reason: 'not_school' });
      await this.assertReadable(journal, source);
      if ((await this.entries.countPending(journal.teacherId, journal.id)) >= MAX_PENDING_PER_JOURNAL)
        throw new AppError('LIMIT_EXCEEDED', 'Too many marks are waiting for the teacher', {
          limit: 'pendingGrades',
          max: MAX_PENDING_PER_JOURNAL,
        });
      const [profile, student] = await Promise.all([
        this.profiles.find(journal.teacherId),
        this.accounts.findById(journal.studentId),
      ]);
      const values = await this.normalizeValues(journal, {
        value: input.value,
        category: input.category,
        comment: input.comment,
      });
      const today = this.today(student?.timezone);
      const auto = profile?.gradeAutoConfirm ?? false;
      const row = await this.entries.insert({
        journalId: journal.id,
        teacherId: journal.teacherId,
        studentId: journal.studentId,
        date: normalizeEntryDate(input.date ?? today, today),
        ...values,
        lessonId: null,
        assignmentId: null,
        source,
        createdBy: actor.accountId,
        status: auto ? 'confirmed' : 'pending',
      });
      await this.entries.addHistory({
        entryId: row.id,
        changedBy: actor.accountId,
        action: 'created',
        before: null,
        after: entrySnapshot(row),
        at: now,
      });
      await this.record(actor, auto ? 'grade.added' : 'grade.proposed', row, null);
      await this.publish(auto ? 'grade.added' : 'grade.proposed', row, journal);
      return row;
    });
  }

  /** The teacher accepts a proposed mark; it becomes an ordinary confirmed record. */
  async confirm(actor: Actor, entryId: string): Promise<GradeEntryRow> {
    return this.decide(actor, entryId, 'confirmed');
  }

  async reject(actor: Actor, entryId: string): Promise<GradeEntryRow> {
    return this.decide(actor, entryId, 'rejected');
  }

  private async decide(
    actor: Actor,
    entryId: string,
    status: 'confirmed' | 'rejected',
  ): Promise<GradeEntryRow> {
    assertRole(actor, 'TEACHER');
    const now = this.clock.now();
    return this.txm.run(async () => {
      const entry = await this.ownEntry(actor, entryId);
      if (entry.status !== 'pending')
        throw new AppError('CONFLICT', 'The mark is already decided', {
          reason: 'decided',
          status: entry.status,
        });
      const journal = await this.ownJournal(actor, entry.journalId);
      const updated = await this.entries.update(entry.id, { status });
      await this.entries.addHistory({
        entryId: entry.id,
        changedBy: actor.accountId,
        action: status,
        before: entrySnapshot(entry),
        after: entrySnapshot(updated),
        at: now,
      });
      await this.record(actor, `grade.${status}`, updated, entrySnapshot(entry));
      await this.publish(status === 'confirmed' ? 'grade.added' : 'grade.rejected', updated, journal);
      return updated;
    });
  }

  // --- helpers ------------------------------------------------------------------------------------

  private async ownJournal(actor: Actor, journalId: string): Promise<JournalRow> {
    const journal = await this.journals.findById(journalId, { forUpdate: true });
    if (!journal || journal.teacherId !== actor.accountId) throw AppError.notFound('journal', journalId);
    await this.features.assertEnabled(actor.accountId, JOURNAL_FEATURE[journal.type]);
    const link = await this.links.findById(journal.teacherStudentId);
    if (!link || link.status !== 'active')
      throw new AppError('LINK_NOT_ACTIVE', 'The student is no longer active at this teacher');
    return journal;
  }

  private async ownEntry(actor: Actor, entryId: string): Promise<GradeEntryRow> {
    const entry = await this.entries.findById(entryId, { forUpdate: true });
    if (!entry || entry.teacherId !== actor.accountId || entry.deletedAt)
      throw AppError.notFound('grade entry', entryId);
    return entry;
  }

  /** Who proposes: the student of the journal, or an active parent of that student (8.0). */
  private async proposerRole(actor: Actor, journal: JournalRow, studentId?: string): Promise<EntrySource> {
    if (actor.roles.includes('STUDENT') && journal.studentId === actor.accountId && !studentId)
      return 'student';
    if (actor.roles.includes('PARENT')) {
      const child = studentId ?? journal.studentId;
      if (child === journal.studentId && (await this.family.findActive(actor.accountId, child)))
        return 'parent';
    }
    throw AppError.notFound('journal', journal.id);
  }

  /** JRN-04 and the read policy (8.0): the journal must be visible to this side and the link readable. */
  private async assertReadable(journal: JournalRow, source: EntrySource): Promise<void> {
    const [link, teacher, student] = await Promise.all([
      this.links.findById(journal.teacherStudentId),
      this.accounts.findById(journal.teacherId),
      this.accounts.findById(journal.studentId),
    ]);
    if (!link || !teacher || !student || linkView(link, teacher.status, student.status) !== 'full')
      throw new AppError('LINK_NOT_ACTIVE', 'The link is not active');
    if (!(await this.features.isEnabled(journal.teacherId, JOURNAL_FEATURE[journal.type])))
      throw new AppError('FEATURE_DISABLED', 'The journal is switched off');
    const visible = journal.hidden
      ? false
      : source === 'student'
        ? journal.visibleToStudent
        : journal.visibleToParent;
    if (!visible) throw AppError.notFound('journal', journal.id);
  }

  /** Type-specific value validation; returns the columns to store. */
  private async normalizeValues(
    journal: JournalRow,
    input: GradeValueInput,
  ): Promise<
    Pick<
      NewGradeEntry,
      | 'category'
      | 'testKindId'
      | 'valueNumeric'
      | 'valueMax'
      | 'scaleValueId'
      | 'parts'
      | 'weight'
      | 'comment'
    >
  > {
    const base = { weight: normalizeWeight(input.weight), comment: normalizeComment(input.comment) };
    if (journal.type === 'school') {
      const scale = await this.journals.findScale(PLATFORM_SCALE_ID);
      if (input.value === null || input.value === undefined)
        throw AppError.validation('A mark is required', { reason: 'value_required' });
      const category = input.category ?? DEFAULT_CATEGORY;
      if (!SCHOOL_CATEGORIES.includes(category))
        throw AppError.validation('Unknown category', { reason: 'category_invalid' });
      return {
        ...base,
        category,
        testKindId: null,
        valueNumeric: normalizeSchoolValue(scale ?? { minValue: 1, maxValue: 10 }, input.value),
        valueMax: null,
        scaleValueId: null,
        parts: null,
      };
    }
    if (journal.type === 'tests') {
      if (input.value === null || input.value === undefined)
        throw AppError.validation('A score is required', { reason: 'value_required' });
      const kinds = await this.journals.listTestKinds(journal.teacherId);
      const kind = input.testKindId ? kinds.find((k) => k.id === input.testKindId) : kinds[0];
      if (!kind) throw AppError.validation('Unknown test kind', { reason: 'kind_invalid' });
      const score = normalizeTestScore({ value: input.value, max: input.max, parts: input.parts });
      return {
        ...base,
        category: null,
        testKindId: kind.id,
        valueNumeric: score.value,
        valueMax: score.max,
        scaleValueId: null,
        parts: score.parts,
      };
    }
    const scale = await this.journals.findCustomScale(journal.teacherId);
    if (!scale) throw AppError.validation('Set up your custom scale first', { reason: 'scale_missing' });
    const values = await this.journals.listScaleValues(scale.id, true);
    const value = values.find((v) => v.id === input.scaleValueId);
    if (!value) throw AppError.validation('Unknown scale value', { reason: 'scale_value_invalid' });
    return {
      ...base,
      category: null,
      testKindId: null,
      valueNumeric: value.weight,
      valueMax: null,
      scaleValueId: value.id,
      parts: null,
    };
  }

  private today(zone: string | undefined): string {
    return DateTime.fromJSDate(this.clock.now(), { zone: zone ?? 'UTC' }).toISODate()!;
  }

  /** 5.11.3 «вложение»: only a tests record carries a file; the draft must be the teacher's own upload. */
  private async attachFile(
    actor: Actor,
    journal: JournalRow,
    fileId: string | null | undefined,
    now: Date,
  ): Promise<string | null> {
    if (!fileId) return null;
    if (journal.type !== 'tests')
      throw AppError.validation('Only a test record takes an attachment', { reason: 'file_not_tests' });
    const attached = await this.files.markAttached([fileId], actor.accountId, now, {
      uploadedBy: actor.accountId,
    });
    if (attached.length === 0) {
      // already attached to this record on a retry, or someone else's / expired draft
      const existing = await this.files.findById(fileId);
      if (!existing || existing.ownerTeacherId !== actor.accountId || existing.status !== 'attached')
        throw new AppError('CONFLICT', 'The file is no longer available', { reason: 'files_expired' });
    }
    return fileId;
  }

  private async record(
    actor: Actor,
    action: string,
    entry: GradeEntryRow,
    before: Record<string, unknown> | null,
  ): Promise<void> {
    await this.audit.record({
      actorId: actor.accountId,
      actorRole: primaryRole(actor),
      action,
      entityType: 'grade_entry',
      entityId: entry.id,
      before,
      after: entrySnapshot(entry),
      source: actor.source,
      ip: actor.ip,
    });
  }

  private async publish(type: string, entry: GradeEntryRow, journal: JournalRow): Promise<void> {
    const payload: EntryEvent = {
      entryId: entry.id,
      journalId: journal.id,
      teacherId: journal.teacherId,
      studentId: journal.studentId,
      type: journal.type,
      subjectId: journal.subjectId,
      source: entry.source,
      createdBy: entry.createdBy,
    };
    await this.outbox.publish({
      type,
      aggregateType: 'grade_entry',
      aggregateId: entry.id,
      payload: { ...payload },
    });
  }
}
