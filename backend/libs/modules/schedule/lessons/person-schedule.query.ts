import { Injectable } from '@nestjs/common';
import { AppError } from '@shared/errors/app-error.js';
import { type Actor, assertActive } from '@modules/access/actor.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import type { AccountRow } from '@modules/identity/schema.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { linkView } from '@modules/people/links/link.rules.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import type { SubjectRow } from '@modules/people/schema.js';
import { SubjectRepository } from '@modules/people/subject.repository.js';
import type { Interval, LessonRow } from '../schema.js';
import { LessonRepository } from './lesson.repository.js';

export interface ListOptions {
  /** Upcoming lists hide cancelled lessons; history lists show them with their status. */
  includeCancelled?: boolean;
  /** History lists: only lessons already over at this instant. */
  endedBefore?: Date;
}

/** A lesson as a student or a parent sees it (5.5.3): full details of their own lessons, teacher by name. */
export interface PersonLessonView {
  lesson: LessonRow;
  teacher: AccountRow;
  subject: SubjectRow | null;
  /** The student the view belongs to (the parent's child). */
  studentId: string;
}

/**
 * Read side of the schedule for StudentBot and ParentBot (M3-06). A student sees their lessons at every
 * teacher whose link is readable (`linkView` ≠ none: active, or ended/blocked → history only); a parent sees
 * the lessons of a child they are actively linked to. Cancelled lessons are listed with their status.
 */
@Injectable()
export class PersonScheduleQuery {
  constructor(
    private readonly lessons: LessonRepository,
    private readonly links: TeacherStudentRepository,
    private readonly family: FamilyLinkRepository,
    private readonly accounts: AccountRepository,
    private readonly subjects: SubjectRepository,
  ) {}

  async forStudent(actor: Actor, range: Interval, options: ListOptions = {}): Promise<PersonLessonView[]> {
    assertActive(actor); // a blocked student is refused here (ACC-01)
    if (!actor.roles.includes('STUDENT')) throw AppError.forbidden('Not a student');
    return this.hydrate(actor.accountId, actor.status, range, options);
  }

  /** The parent must hold an active family link to the child (5.4.3, 8.0). */
  async forChild(
    actor: Actor,
    studentId: string,
    range: Interval,
    options: ListOptions = {},
  ): Promise<PersonLessonView[]> {
    assertActive(actor);
    if (!actor.roles.includes('PARENT') || !(await this.family.findActive(actor.accountId, studentId)))
      throw AppError.notFound('child', studentId);
    const child = await this.accounts.findById(studentId);
    if (!child) throw AppError.notFound('child', studentId);
    return this.hydrate(studentId, child.status, range, options);
  }

  /** One lesson by id for a student or a parent of a participant; NOT_FOUND otherwise (8.0). */
  async lesson(actor: Actor, lessonId: string): Promise<PersonLessonView> {
    assertActive(actor);
    const lesson = await this.lessons.findById(lessonId);
    if (!lesson) throw AppError.notFound('lesson', lessonId);
    const participants = (await this.lessons.listParticipants(lesson.id)).map((p) => p.studentId);
    let studentId: string | null = null;
    if (actor.roles.includes('STUDENT') && participants.includes(actor.accountId))
      studentId = actor.accountId;
    else if (actor.roles.includes('PARENT')) {
      // one query: the parent's children, then the first of them taking part (deterministic by link order)
      const children = (await this.family.listActiveByParent(actor.accountId)).map((l) => l.studentId);
      studentId = children.find((id) => participants.includes(id)) ?? null;
    }
    if (!studentId) throw AppError.notFound('lesson', lessonId);
    // the viewed student's own status decides (a blocked child is invisible to the parent too, ACC-01)
    const student = studentId === actor.accountId ? null : await this.accounts.findById(studentId);
    const views = await this.hydrateRows(studentId, student?.status ?? actor.status, [lesson]);
    if (views.length === 0) throw AppError.notFound('lesson', lessonId);
    return views[0]!;
  }

  private async hydrate(
    studentId: string,
    studentStatus: AccountRow['status'],
    range: Interval,
    options: ListOptions,
  ): Promise<PersonLessonView[]> {
    let rows = await this.lessons.listByStudent(studentId, range);
    if (!options.includeCancelled) rows = rows.filter((l) => l.status !== 'cancelled');
    const endedBefore = options.endedBefore;
    if (endedBefore) rows = rows.filter((l) => l.endsAt.getTime() <= endedBefore.getTime());
    return this.hydrateRows(studentId, studentStatus, rows);
  }

  private async hydrateRows(
    studentId: string,
    studentStatus: AccountRow['status'],
    rows: LessonRow[],
  ): Promise<PersonLessonView[]> {
    if (rows.length === 0) return [];
    const links = await this.links.listByStudent(studentId, ['active', 'ended']);
    // one row per pair is the rule (PPL-02); should history ever hold two, the active one decides
    const linkByTeacher = new Map<string, (typeof links)[number]>();
    for (const l of links) {
      const seen = linkByTeacher.get(l.teacherId);
      if (!seen || (seen.status !== 'active' && l.status === 'active')) linkByTeacher.set(l.teacherId, l);
    }
    const teacherIds = [...new Set(rows.map((l) => l.teacherId))];
    const subjectIds = [...new Set(rows.map((l) => l.subjectId).filter((id): id is string => id !== null))];
    const [teachers, subjects] = await Promise.all([
      this.accounts.findByIds(teacherIds),
      this.subjects.findByIds(subjectIds),
    ]);
    const teacherById = new Map(teachers.map((t) => [t.id, t]));
    const subjectById = new Map(subjects.map((s) => [s.id, s]));
    const out: PersonLessonView[] = [];
    for (const lesson of rows) {
      const teacher = teacherById.get(lesson.teacherId);
      const link = linkByTeacher.get(lesson.teacherId);
      if (!teacher || !link || linkView(link, teacher.status, studentStatus) === 'none') continue;
      out.push({
        lesson,
        teacher,
        subject: lesson.subjectId ? (subjectById.get(lesson.subjectId) ?? null) : null,
        studentId,
      });
    }
    return out;
  }
}
