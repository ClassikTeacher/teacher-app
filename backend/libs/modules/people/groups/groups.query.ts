import { Injectable } from '@nestjs/common';
import { AppError } from '@shared/errors/app-error.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import type { AccountRow } from '@modules/identity/schema.js';
import { cardDisplayName } from '../links/students.query.js';
import { TeacherStudentRepository } from '../links/teacher-student.repository.js';
import type { GroupMemberRow, StudyGroupRow, SubjectRow, TeacherStudentRow } from '../schema.js';
import { SubjectRepository } from '../subject.repository.js';
import { GroupRepository } from './group.repository.js';

export interface GroupListItem {
  group: StudyGroupRow;
  memberCount: number;
}

export interface GroupMemberItem {
  member: GroupMemberRow;
  student: AccountRow;
  link: TeacherStudentRow;
  displayName: string;
}

export interface GroupDetails {
  group: StudyGroupRow;
  subject: SubjectRow | null;
  members: GroupMemberItem[];
}

/** Read side of groups for the teacher's screens and REST (ownership enforced by teacher_id). */
@Injectable()
export class GroupsQuery {
  constructor(
    private readonly groups: GroupRepository,
    private readonly links: TeacherStudentRepository,
    private readonly accounts: AccountRepository,
    private readonly subjects: SubjectRepository,
  ) {}

  async listActive(teacherId: string): Promise<GroupListItem[]> {
    const groups = await this.groups.listByTeacher(teacherId, { archived: false });
    const counts = await this.groups.countMembers(groups.map((g) => g.id));
    return groups.map((group) => ({ group, memberCount: counts.get(group.id) ?? 0 }));
  }

  async listArchived(teacherId: string): Promise<StudyGroupRow[]> {
    return this.groups.listByTeacher(teacherId, { archived: true });
  }

  /** Throws NOT_FOUND for another teacher's group (8.0). */
  async details(teacherId: string, groupId: string): Promise<GroupDetails> {
    const group = await this.groups.findById(groupId);
    if (!group || group.teacherId !== teacherId) throw AppError.notFound('group', groupId);
    const [members, subject] = await Promise.all([
      this.groups.listMembers(group.id),
      group.subjectId ? this.subjects.findById(group.subjectId) : null,
    ]);
    const studentIds = members.map((m) => m.studentId);
    const [students, links] = await Promise.all([
      this.accounts.findByIds(studentIds),
      this.links
        .listByTeacher(teacherId, ['active', 'ended'])
        .then((rows) => rows.filter((l) => l.studentId && studentIds.includes(l.studentId))),
    ]);
    const studentById = new Map(students.map((s) => [s.id, s]));
    const linkByStudent = new Map(links.filter((l) => l.studentId).map((l) => [l.studentId!, l]));
    const items: GroupMemberItem[] = [];
    for (const member of members) {
      const student = studentById.get(member.studentId);
      const link = linkByStudent.get(member.studentId);
      if (!student || !link) continue;
      items.push({ member, student, link, displayName: cardDisplayName({ link, student }) });
    }
    items.sort(
      (a, b) => a.displayName.localeCompare(b.displayName, 'ru') || a.student.id.localeCompare(b.student.id),
    );
    return { group, subject, members: items };
  }

  /** Active students of the teacher who are not yet in the group (candidates for "add member"). */
  async candidates(
    teacherId: string,
    groupId: string,
  ): Promise<Array<{ link: TeacherStudentRow; student: AccountRow; displayName: string }>> {
    const [links, members] = await Promise.all([
      this.links.listByTeacher(teacherId, ['active']),
      this.groups.listMembers(groupId),
    ]);
    const inGroup = new Set(members.map((m) => m.studentId));
    const free = links.filter((l) => l.studentId && !inGroup.has(l.studentId));
    const students = new Map(
      (await this.accounts.findByIds(free.map((l) => l.studentId!))).map((s) => [s.id, s]),
    );
    return free
      .flatMap((link) => {
        const student = students.get(link.studentId!);
        return student ? [{ link, student, displayName: cardDisplayName({ link, student }) }] : [];
      })
      .sort(
        (a, b) =>
          a.displayName.localeCompare(b.displayName, 'ru') || a.student.id.localeCompare(b.student.id),
      );
  }
}
