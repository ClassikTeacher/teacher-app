import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { type Actor, assertRole, primaryRole } from '@modules/access/actor.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { JournalsPort } from '../journals.port.js';
import type { TeacherStudentRow } from '../schema.js';
import { StudentProfileRepository } from '../student-profile.repository.js';
import { SubjectRepository } from '../subject.repository.js';
import {
  assertLinkActive,
  MAX_ALIAS_LENGTH,
  MAX_GOALS_LENGTH,
  MAX_GRADE_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_SCHOOL_LENGTH,
  normalizeWeeklyLimit,
} from './link.rules.js';
import { TeacherStudentRepository } from './teacher-student.repository.js';

/** Editable fields of the student card (5.4.1). `null` clears an optional text; `undefined` leaves it unchanged. */
export interface StudentCardPatch {
  alias?: string | null;
  goals?: string | null;
  notes?: string | null;
  maxLessonsPerWeek?: number | null;
  /** Override of the teacher's calendar mode for this student; null = follow the teacher default. */
  calendarOpen?: boolean | null;
  subjectIds?: string[];
  /** Shared student facts (student_profile), editable by the teacher too (5.4.1 "класс, школа"). */
  grade?: string | null;
  school?: string | null;
}

export type CardField = keyof StudentCardPatch;

const TEXT_LIMITS: Partial<Record<CardField, number>> = {
  alias: MAX_ALIAS_LENGTH,
  goals: MAX_GOALS_LENGTH,
  notes: MAX_NOTES_LENGTH,
  grade: MAX_GRADE_LENGTH,
  school: MAX_SCHOOL_LENGTH,
};

/** PATCH /students/{id} and the card screens: the owner teacher edits an active card; new subjects get journals (JRN-02). */
@Injectable()
export class UpdateStudentCardUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly links: TeacherStudentRepository,
    private readonly profiles: StudentProfileRepository,
    private readonly subjects: SubjectRepository,
    private readonly journals: JournalsPort,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: Actor, linkId: string, patch: StudentCardPatch): Promise<TeacherStudentRow> {
    assertRole(actor, 'TEACHER');
    const clean = this.validate(patch);
    if (Object.keys(clean).length === 0) throw AppError.validation('Nothing to update');
    if (clean.subjectIds) await this.assertSubjects(clean.subjectIds);
    return this.txm.run(async () => {
      const { link, studentId } = await this.ownActiveCard(actor, linkId);
      return this.apply(actor, link, studentId, clean);
    });
  }

  /**
   * Adds or removes one subject atomically (the card is locked, so two quick taps cannot lose each other);
   * the last subject cannot be removed, new subjects get journals.
   */
  async toggleSubject(actor: Actor, linkId: string, subjectId: string): Promise<TeacherStudentRow> {
    assertRole(actor, 'TEACHER');
    return this.txm.run(async () => {
      const { link, studentId } = await this.ownActiveCard(actor, linkId);
      const has = link.subjectIds.includes(subjectId);
      const next = has ? link.subjectIds.filter((id) => id !== subjectId) : [...link.subjectIds, subjectId];
      if (next.length === 0) throw AppError.validation('At least one subject is required');
      if (!has) await this.assertSubjects([subjectId]);
      return this.apply(actor, link, studentId, { subjectIds: next });
    });
  }

  private async ownActiveCard(
    actor: Actor,
    linkId: string,
  ): Promise<{ link: TeacherStudentRow; studentId: string }> {
    const link = await this.links.findById(linkId, { forUpdate: true });
    if (!link || link.teacherId !== actor.accountId) throw AppError.notFound('student card', linkId);
    assertLinkActive(link); // a pending card has no student yet: LINK_NOT_ACTIVE, not 404
    if (!link.studentId) throw AppError.notFound('student card', linkId);
    return { link, studentId: link.studentId };
  }

  private async apply(
    actor: Actor,
    link: TeacherStudentRow,
    studentId: string,
    clean: StudentCardPatch,
  ): Promise<TeacherStudentRow> {
    const { grade, school, ...linkPatch } = clean;
    const profileBefore = await this.profiles.find(studentId);
    const updated = Object.keys(linkPatch).length > 0 ? await this.links.update(link.id, linkPatch) : link;
    if (grade !== undefined || school !== undefined) {
      // shared student facts (T-15): last writer wins, old and new values are audited
      await this.profiles.upsert(studentId, {
        ...(grade !== undefined ? { grade } : {}),
        ...(school !== undefined ? { school } : {}),
      });
    }
    const added = clean.subjectIds?.filter((id) => !link.subjectIds.includes(id)) ?? [];
    if (added.length > 0) {
      await this.journals.ensureForLink({
        linkId: link.id,
        teacherId: link.teacherId,
        studentId,
        subjectIds: added,
      });
    }
    const fields = Object.keys(clean) as CardField[];
    await this.audit.record({
      actorId: actor.accountId,
      actorRole: primaryRole(actor),
      action: 'student.card_updated',
      entityType: 'teacher_student',
      entityId: link.id,
      before: { fields, ...this.auditView(link, profileBefore, fields) },
      after: {
        fields,
        ...this.auditView(
          updated,
          { grade: grade ?? profileBefore?.grade ?? null, school: school ?? profileBefore?.school ?? null },
          fields,
        ),
      },
      source: actor.source,
      ip: actor.ip,
    });
    return updated;
  }

  /** AUD-01 "без лишних персональных данных": scalars and shared facts in full, private texts as lengths only. */
  private auditView(
    link: TeacherStudentRow,
    profile: { grade: string | null; school: string | null } | null,
    fields: CardField[],
  ): Record<string, unknown> {
    const view: Record<string, unknown> = {};
    if (fields.includes('maxLessonsPerWeek')) view['maxLessonsPerWeek'] = link.maxLessonsPerWeek;
    if (fields.includes('calendarOpen')) view['calendarOpen'] = link.calendarOpen;
    if (fields.includes('subjectIds')) view['subjectIds'] = link.subjectIds;
    if (fields.includes('grade')) view['grade'] = profile?.grade ?? null;
    if (fields.includes('school')) view['school'] = profile?.school ?? null;
    if (fields.includes('alias')) view['aliasLength'] = link.alias?.length ?? 0;
    if (fields.includes('goals')) view['goalsLength'] = link.goals?.length ?? 0;
    if (fields.includes('notes')) view['notesLength'] = link.notes?.length ?? 0;
    return view;
  }

  private validate(patch: StudentCardPatch): StudentCardPatch {
    const clean: StudentCardPatch = {};
    for (const field of ['alias', 'goals', 'notes', 'grade', 'school'] as const) {
      const value = patch[field];
      if (value === undefined) continue;
      const trimmed = value?.trim() ?? '';
      if (trimmed.length > TEXT_LIMITS[field]!)
        throw AppError.validation(`${field} is too long`, { max: TEXT_LIMITS[field] });
      clean[field] = trimmed || null;
    }
    if (patch.maxLessonsPerWeek !== undefined)
      clean.maxLessonsPerWeek = normalizeWeeklyLimit(patch.maxLessonsPerWeek);
    if (patch.calendarOpen !== undefined) clean.calendarOpen = patch.calendarOpen;
    if (patch.subjectIds !== undefined) {
      const unique = [...new Set(patch.subjectIds)];
      if (unique.length === 0) throw AppError.validation('At least one subject is required');
      clean.subjectIds = unique;
    }
    return clean;
  }

  private async assertSubjects(ids: string[]): Promise<void> {
    const found = await this.subjects.findByIds(ids);
    if (found.length !== ids.length || found.some((s) => !s.isActive)) {
      throw AppError.validation('Unknown or inactive subject');
    }
  }
}
