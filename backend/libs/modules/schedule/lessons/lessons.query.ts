import { Injectable } from '@nestjs/common';
import { AppError } from '@shared/errors/app-error.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import type { AccountRow } from '@modules/identity/schema.js';
import { GroupRepository } from '@modules/people/groups/group.repository.js';
import { cardDisplayName } from '@modules/people/links/students.query.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import type { StudyGroupRow, SubjectRow, TeacherStudentRow } from '@modules/people/schema.js';
import { SubjectRepository } from '@modules/people/subject.repository.js';
import type { Interval, LessonParticipantRow, LessonRow, LessonStatus } from '../schema.js';
import { LessonRepository } from './lesson.repository.js';

export interface LessonParticipantView {
  participant: LessonParticipantRow;
  student: AccountRow;
  /** How the teacher names the student (alias first); students see real names. */
  displayName: string;
}

export interface LessonView {
  lesson: LessonRow;
  participants: LessonParticipantView[];
  group: StudyGroupRow | null;
  subject: SubjectRow | null;
}

/** A student or a group the teacher may schedule with (5.6.3 step 1), recent first. */
export type LessonTargetItem =
  | { kind: 'student'; studentId: string; link: TeacherStudentRow; student: AccountRow; label: string }
  | { kind: 'group'; groupId: string; group: StudyGroupRow; label: string; memberCount: number };

/** Read side of lessons for the teacher's screens and REST; ownership enforced by teacher_id (8.0). */
@Injectable()
export class LessonsQuery {
  constructor(
    private readonly lessons: LessonRepository,
    private readonly accounts: AccountRepository,
    private readonly links: TeacherStudentRepository,
    private readonly groups: GroupRepository,
    private readonly subjects: SubjectRepository,
  ) {}

  /** Lessons of the teacher in the range with participants, names and subjects (lists and day views). */
  async teacherLessons(
    teacherId: string,
    range: Interval,
    statuses?: readonly LessonStatus[],
  ): Promise<LessonView[]> {
    return this.hydrate(teacherId, await this.lessons.listByTeacher(teacherId, range, statuses));
  }

  async awaitingReport(teacherId: string): Promise<LessonView[]> {
    return this.hydrate(teacherId, await this.lessons.listAwaitingReport(teacherId));
  }

  /** Throws NOT_FOUND for another teacher's lesson (8.0). */
  async teacherLesson(teacherId: string, lessonId: string): Promise<LessonView> {
    const lesson = await this.lessons.findById(lessonId);
    if (!lesson || lesson.teacherId !== teacherId) throw AppError.notFound('lesson', lessonId);
    return (await this.hydrate(teacherId, [lesson]))[0]!;
  }

  /** The teacher's lessons among the given ids, hydrated, in start order (foreign ids are dropped, 8.0). */
  async teacherLessonsByIds(teacherId: string, ids: readonly string[]): Promise<LessonView[]> {
    const rows = (await this.lessons.findByIds(ids))
      .filter((l) => l.teacherId === teacherId)
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id.localeCompare(b.id));
    return this.hydrate(teacherId, rows);
  }

  /** Current members of a group (ids only), for slot suggestions of a group lesson. */
  async groupMemberIds(groupId: string): Promise<string[]> {
    return (await this.groups.listMembers(groupId)).map((m) => m.studentId);
  }

  /** Active students and groups, those scheduled most recently first (5.6.3 "последние сверху"). */
  async targets(teacherId: string): Promise<LessonTargetItem[]> {
    const [links, groups, recent] = await Promise.all([
      this.links.listByTeacher(teacherId, ['active']),
      this.groups.listByTeacher(teacherId, { archived: false }),
      this.lessons.recentTargets(teacherId),
    ]);
    const studentIds = links.map((l) => l.studentId).filter((id): id is string => id !== null);
    const [students, counts] = await Promise.all([
      this.accounts.findByIds(studentIds),
      this.groups.countMembers(groups.map((g) => g.id)),
    ]);
    const studentById = new Map(students.map((s) => [s.id, s]));
    const items: LessonTargetItem[] = [];
    for (const link of links) {
      const student = link.studentId ? studentById.get(link.studentId) : undefined;
      if (!student) continue;
      items.push({
        kind: 'student',
        studentId: student.id,
        link,
        student,
        label: cardDisplayName({ link, student }),
      });
    }
    for (const group of groups) {
      items.push({
        kind: 'group',
        groupId: group.id,
        group,
        label: `${group.emoji ? `${group.emoji} ` : ''}${group.name}`,
        memberCount: counts.get(group.id) ?? 0,
      });
    }
    const rank = new Map<string, number>();
    recent.forEach((r, i) => {
      const key = r.groupId ? `g:${r.groupId}` : r.studentId ? `s:${r.studentId}` : null;
      if (key && !rank.has(key)) rank.set(key, i);
    });
    const keyOf = (t: LessonTargetItem): string =>
      t.kind === 'group' ? `g:${t.groupId}` : `s:${t.studentId}`;
    return items.sort((a, b) => {
      const ra = rank.get(keyOf(a)) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(keyOf(b)) ?? Number.MAX_SAFE_INTEGER;
      return ra - rb || a.label.localeCompare(b.label, 'ru');
    });
  }

  private async hydrate(teacherId: string, rows: LessonRow[]): Promise<LessonView[]> {
    if (rows.length === 0) return [];
    const participants = await this.lessons.listParticipantsOf(rows.map((l) => l.id));
    const studentIds = [...new Set([...participants.values()].flat().map((p) => p.studentId))];
    const groupIds = [...new Set(rows.map((l) => l.groupId).filter((id): id is string => id !== null))];
    const subjectIds = [...new Set(rows.map((l) => l.subjectId).filter((id): id is string => id !== null))];
    const [students, links, groups, subjects] = await Promise.all([
      this.accounts.findByIds(studentIds),
      this.links.listByTeacher(teacherId, ['active', 'ended']),
      Promise.all(groupIds.map((id) => this.groups.findById(id))),
      this.subjects.findByIds(subjectIds),
    ]);
    const studentById = new Map(students.map((s) => [s.id, s]));
    const linkByStudent = new Map(links.filter((l) => l.studentId).map((l) => [l.studentId!, l]));
    const groupById = new Map(groups.filter((g): g is StudyGroupRow => g !== null).map((g) => [g.id, g]));
    const subjectById = new Map(subjects.map((s) => [s.id, s]));
    return rows.map((lesson) => ({
      lesson,
      participants: (participants.get(lesson.id) ?? []).flatMap((participant) => {
        const student = studentById.get(participant.studentId);
        if (!student) return [];
        const link = linkByStudent.get(student.id);
        const displayName = link
          ? cardDisplayName({ link, student })
          : `${student.firstName} ${student.lastName}`.trim();
        return [{ participant, student, displayName }];
      }),
      group: lesson.groupId ? (groupById.get(lesson.groupId) ?? null) : null,
      subject: lesson.subjectId ? (subjectById.get(lesson.subjectId) ?? null) : null,
    }));
  }
}
