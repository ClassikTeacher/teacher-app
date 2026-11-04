import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PG_UNIQUE_VIOLATION } from '@shared/db/drizzle.js';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { type Actor, assertRole } from '@modules/access/actor.js';
import { FeatureService } from '@modules/access/features/feature.service.js';
import { AuditService } from '@modules/audit/audit.service.js';
import {
  type JournalLinkContext,
  JournalsPort,
  type JournalsProvisioner,
} from '@modules/people/journals.port.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { GradeEntryRepository } from './grade-entry.repository.js';
import {
  JOURNAL_FEATURE,
  JOURNAL_ORDER,
  MAX_SCALE_TITLE_LENGTH,
  MAX_TEST_KIND_NAME_LENGTH,
  normalizeScaleValues,
  normalizeTestScore,
  type ScaleValueInput,
} from './gradebook.rules.js';
import { JournalRepository } from './journal.repository.js';
import type { GradeScaleRow, GradeScaleValueRow, JournalRow, TestKindRow } from './schema.js';

export interface JournalSettingsPatch {
  visibleToStudent?: boolean;
  visibleToParent?: boolean;
  hidden?: boolean;
  /** Tests: the goal (💡 target line), null clears it; stored as a percent of the maximum (0–100). */
  targetPercent?: number | null;
}

export interface CustomScaleView {
  scale: GradeScaleRow;
  values: GradeScaleValueRow[];
}

/**
 * UC-29 settings side: journals per link (JRN-01…02, bound to the people port), visibility (JRN-04), the
 * teacher's custom scale (5.11.4, JRN-06), test kinds (5.11.3). Rights: the owner teacher only (8.0).
 */
@Injectable()
export class JournalsUseCase implements OnModuleInit, JournalsProvisioner {
  constructor(
    private readonly txm: TransactionManager,
    private readonly journals: JournalRepository,
    private readonly entries: GradeEntryRepository,
    private readonly links: TeacherStudentRepository,
    private readonly profiles: TeacherProfileRepository,
    private readonly features: FeatureService,
    private readonly audit: AuditService,
    private readonly port: JournalsPort,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.port.bind(this);
  }

  /** JRN-02: three journals for every subject of the link; already existing ones are kept. */
  async ensureForLink(context: JournalLinkContext): Promise<void> {
    await this.journals.ensure(
      context.subjectIds.flatMap((subjectId) =>
        JOURNAL_ORDER.map((type) => ({
          teacherStudentId: context.linkId,
          teacherId: context.teacherId,
          studentId: context.studentId,
          subjectId,
          type,
        })),
      ),
    );
  }

  /** The teacher's own journal or NOT_FOUND (8.0); the journal's feature must be on (5.3.3). */
  async own(actor: Actor, journalId: string, options: { forUpdate?: boolean } = {}): Promise<JournalRow> {
    assertRole(actor, 'TEACHER');
    const row = await this.journals.findById(journalId, options);
    if (!row || row.teacherId !== actor.accountId) throw AppError.notFound('journal', journalId);
    await this.features.assertEnabled(actor.accountId, JOURNAL_FEATURE[row.type]);
    return row;
  }

  async updateSettings(actor: Actor, journalId: string, patch: JournalSettingsPatch): Promise<JournalRow> {
    return this.txm.run(async () => {
      const row = await this.own(actor, journalId, { forUpdate: true });
      const clean: Parameters<JournalRepository['update']>[1] = {};
      if (patch.visibleToStudent !== undefined) clean.visibleToStudent = patch.visibleToStudent;
      if (patch.visibleToParent !== undefined) clean.visibleToParent = patch.visibleToParent;
      if (patch.hidden !== undefined) clean.hidden = patch.hidden;
      if (patch.targetPercent !== undefined) {
        if (row.type !== 'tests')
          throw AppError.validation('Only the tests journal has a target', { reason: 'target_not_tests' });
        clean.targetScore =
          patch.targetPercent === null
            ? null
            : normalizeTestScore({ value: patch.targetPercent, max: 100 }).value;
      }
      if (Object.keys(clean).length === 0) throw AppError.validation('Nothing to update');
      const updated = await this.journals.update(row.id, clean);
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: 'TEACHER',
        action: 'journal.settings_updated',
        entityType: 'journal',
        entityId: row.id,
        before: Object.fromEntries(Object.keys(clean).map((k) => [k, row[k as keyof JournalRow]])),
        after: clean,
        source: actor.source,
        ip: actor.ip,
      });
      return updated;
    });
  }

  /** Toggles one visibility flag (the buttons of the journal screen). */
  async toggle(
    actor: Actor,
    journalId: string,
    flag: 'visibleToStudent' | 'visibleToParent' | 'hidden',
  ): Promise<JournalRow> {
    return this.txm.run(async () => {
      const row = await this.own(actor, journalId, { forUpdate: true });
      return this.updateSettings(actor, journalId, { [flag]: !row[flag] });
    });
  }

  // --- custom scale (5.11.4) ----------------------------------------------------------------------

  async customScale(actor: Actor): Promise<CustomScaleView | null> {
    assertRole(actor, 'TEACHER');
    const scale = await this.journals.findCustomScale(actor.accountId);
    if (!scale) return null;
    return { scale, values: await this.journals.listScaleValues(scale.id) };
  }

  /**
   * Replaces the teacher's custom scale with the given values (PUT semantics). Values are matched by label:
   * kept ones keep their id (and the entries referencing them), removed ones in use are archived (JRN-06),
   * unused ones are archived as well (history stays readable). Order and emoji follow the input.
   */
  async putCustomScale(
    actor: Actor,
    input: { title?: string | null; values: readonly ScaleValueInput[] },
  ): Promise<CustomScaleView> {
    assertRole(actor, 'TEACHER');
    await this.features.assertEnabled(actor.accountId, 'journal.custom');
    const values = normalizeScaleValues(input.values);
    const title = (input.title ?? '').trim() || 'Моя шкала';
    if (title.length > MAX_SCALE_TITLE_LENGTH)
      throw AppError.validation('The title is too long', { max: MAX_SCALE_TITLE_LENGTH });
    const now = this.clock.now();
    return this.txm.run(async () => {
      await this.profiles.find(actor.accountId, { forUpdate: true }); // serialises two concurrent edits
      let scale = await this.journals.findCustomScale(actor.accountId, { forUpdate: true });
      scale = scale
        ? scale.title === title
          ? scale
          : await this.journals.updateScale(scale.id, { title })
        : await this.journals.insertScale({ ownerId: actor.accountId, title });
      const existing = await this.journals.listScaleValues(scale.id);
      const byLabel = new Map(existing.map((v) => [v.label.toLowerCase(), v]));
      const kept = new Set<string>();
      for (const [position, v] of values.entries()) {
        const current = byLabel.get(v.label.toLowerCase());
        if (current) {
          kept.add(current.id);
          if (
            current.position !== position ||
            current.emoji !== v.emoji ||
            current.weight !== v.weight ||
            current.label !== v.label ||
            current.archivedAt !== null
          )
            await this.journals.updateScaleValue(current.id, {
              label: v.label,
              emoji: v.emoji,
              weight: v.weight,
              position,
              archivedAt: null,
            });
        } else {
          await this.journals.insertScaleValue({
            scaleId: scale.id,
            label: v.label,
            emoji: v.emoji,
            weight: v.weight,
            position,
          });
        }
      }
      for (const v of existing) {
        if (kept.has(v.id) || v.archivedAt) continue;
        // JRN-06: a value with records is hidden for new entries, never deleted
        await this.journals.updateScaleValue(v.id, { archivedAt: now });
      }
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: 'TEACHER',
        action: 'grade_scale.updated',
        entityType: 'grade_scale',
        entityId: scale.id,
        before: { values: existing.filter((v) => !v.archivedAt).map((v) => v.label) },
        after: { title, values: values.map((v) => v.label) },
        source: actor.source,
        ip: actor.ip,
      });
      return { scale, values: await this.journals.listScaleValues(scale.id) };
    });
  }

  /** JRN-06 from the bot: hides one value for new records (archives it). */
  async archiveScaleValue(actor: Actor, valueId: string): Promise<GradeScaleValueRow> {
    assertRole(actor, 'TEACHER');
    return this.txm.run(async () => {
      const scale = await this.journals.findCustomScale(actor.accountId, { forUpdate: true });
      const value = (await this.journals.findScaleValues([valueId]))[0];
      if (!scale || !value || value.scaleId !== scale.id) throw AppError.notFound('scale value', valueId);
      const live = (await this.journals.listScaleValues(scale.id, true)).filter((v) => v.id !== value.id);
      if (live.length < 2)
        throw AppError.validation('A scale keeps at least two values', { reason: 'values_count', min: 2 });
      const updated = await this.journals.updateScaleValue(value.id, { archivedAt: this.clock.now() });
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: 'TEACHER',
        action: 'grade_scale.value_archived',
        entityType: 'grade_scale',
        entityId: scale.id,
        after: { label: value.label, inUse: await this.entries.scaleValueInUse(value.id) },
        source: actor.source,
        ip: actor.ip,
      });
      return updated;
    });
  }

  // --- test kinds (5.11.3) ------------------------------------------------------------------------

  async testKinds(actor: Actor): Promise<TestKindRow[]> {
    assertRole(actor, 'TEACHER');
    return this.journals.listTestKinds(actor.accountId);
  }

  async addTestKind(actor: Actor, name: string): Promise<TestKindRow> {
    assertRole(actor, 'TEACHER');
    await this.features.assertEnabled(actor.accountId, 'journal.tests');
    const clean = name.trim();
    if (!clean || clean.length > MAX_TEST_KIND_NAME_LENGTH)
      throw AppError.validation('A kind name is required', { max: MAX_TEST_KIND_NAME_LENGTH });
    return this.txm.run(async () => {
      const all = await this.journals.listTestKinds(actor.accountId);
      if (all.some((k) => k.name.toLowerCase() === clean.toLowerCase()))
        throw new AppError('CONFLICT', 'Such a kind already exists', { reason: 'duplicate' });
      const position = Math.max(0, ...all.map((k) => k.position)) + 10;
      let row: TestKindRow;
      try {
        row = await this.txm.runSavepoint(async () =>
          this.journals.insertTestKind({ ownerId: actor.accountId, name: clean, position }),
        );
      } catch (error) {
        // two parallel adds of the same name: the unique index decides, the loser gets a clean conflict
        if ((error as { code?: string }).code !== PG_UNIQUE_VIOLATION) throw error;
        throw new AppError('CONFLICT', 'Such a kind already exists', { reason: 'duplicate' });
      }
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: 'TEACHER',
        action: 'test_kind.added',
        entityType: 'test_kind',
        entityId: row.id,
        after: { name: clean },
        source: actor.source,
        ip: actor.ip,
      });
      return row;
    });
  }

  async removeTestKind(actor: Actor, kindId: string): Promise<void> {
    assertRole(actor, 'TEACHER');
    await this.txm.run(async () => {
      const kind = await this.journals.findTestKind(kindId);
      if (!kind || kind.ownerId !== actor.accountId || kind.archivedAt)
        throw AppError.notFound('test kind', kindId);
      await this.journals.archiveTestKind(kind.id, this.clock.now());
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: 'TEACHER',
        action: 'test_kind.removed',
        entityType: 'test_kind',
        entityId: kind.id,
        before: { name: kind.name },
        source: actor.source,
        ip: actor.ip,
      });
    });
  }

  // --- auto-confirm (5.11.2 💡) -------------------------------------------------------------------

  async toggleAutoConfirm(actor: Actor): Promise<boolean> {
    assertRole(actor, 'TEACHER');
    return this.txm.run(async () => {
      const profile = await this.profiles.find(actor.accountId, { forUpdate: true });
      if (!profile) throw AppError.notFound('teacher profile', actor.accountId);
      const next = !profile.gradeAutoConfirm;
      await this.profiles.upsert(actor.accountId, { gradeAutoConfirm: next });
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: 'TEACHER',
        action: 'teacher.settings_updated',
        entityType: 'teacher_profile',
        entityId: actor.accountId,
        before: { gradeAutoConfirm: profile.gradeAutoConfirm },
        after: { gradeAutoConfirm: next },
        source: actor.source,
        ip: actor.ip,
      });
      return next;
    });
  }

  /** The active link of a teacher and a student, or null. */
  async activeLink(teacherId: string, studentId: string) {
    const link = await this.links.findByPair(teacherId, studentId);
    return link?.status === 'active' ? link : null;
  }
}
