import { Injectable } from '@nestjs/common';
import { AccountRepository } from '@modules/identity/account.repository.js';
import type { AccountRow } from '@modules/identity/schema.js';
import { linkView } from '../links/link.rules.js';
import { TeacherStudentRepository } from '../links/teacher-student.repository.js';
import type { FamilyLinkRow, SubjectRow, TeacherStudentRow } from '../schema.js';
import { SubjectRepository } from '../subject.repository.js';
import { FamilyLinkRepository } from './family-link.repository.js';

export interface ParentItem {
  link: FamilyLinkRow;
  parent: AccountRow;
}

export interface ChildTeacherItem {
  link: TeacherStudentRow;
  teacher: AccountRow;
  subjects: SubjectRow[];
}

/** Read side of family links: parents of a student, teachers of a child as a parent sees them (8.0). */
@Injectable()
export class FamilyQuery {
  constructor(
    private readonly family: FamilyLinkRepository,
    private readonly links: TeacherStudentRepository,
    private readonly accounts: AccountRepository,
    private readonly subjects: SubjectRepository,
  ) {}

  /** Active parents of a student with their accounts, in link order. */
  async parentsOf(studentId: string): Promise<ParentItem[]> {
    const links = await this.family.listActiveByStudent(studentId);
    const byId = new Map((await this.accounts.findByIds(links.map((l) => l.parentId))).map((a) => [a.id, a]));
    return links.flatMap((link) => {
      const parent = byId.get(link.parentId);
      return parent ? [{ link, parent }] : [];
    });
  }

  /** True when the parent is actively linked to the student (context check for every parent action). */
  async isParentOf(parentId: string, studentId: string): Promise<boolean> {
    return (await this.family.findActive(parentId, studentId)) !== null;
  }

  /** Teachers of a child with a `full` view (active link, teacher not blocked) for the parent screens. */
  async teachersOfChild(studentId: string, studentStatus: AccountRow['status']): Promise<ChildTeacherItem[]> {
    const links = await this.links.listByStudent(studentId, ['active']);
    const [teacherRows, subjectRows] = await Promise.all([
      this.accounts.findByIds(links.map((l) => l.teacherId)),
      this.subjects.findByIds([...new Set(links.flatMap((l) => l.subjectIds))]),
    ]);
    const teachers = new Map(teacherRows.map((a) => [a.id, a]));
    const subjects = new Map(subjectRows.map((x) => [x.id, x]));
    return links.flatMap((link) => {
      const teacher = teachers.get(link.teacherId);
      if (!teacher || linkView(link, teacher.status, studentStatus) !== 'full') return [];
      return [{ link, teacher, subjects: link.subjectIds.flatMap((id) => subjects.get(id) ?? []) }];
    });
  }

  /** One teacher of the child by link id, or null when the link is not the child's or not viewable. */
  async teacherOfChild(
    studentId: string,
    studentStatus: AccountRow['status'],
    linkId: string,
  ): Promise<ChildTeacherItem | null> {
    const link = await this.links.findById(linkId);
    if (!link || link.studentId !== studentId || link.status !== 'active') return null;
    const teacher = await this.accounts.findById(link.teacherId);
    if (!teacher || linkView(link, teacher.status, studentStatus) !== 'full') return null;
    return { link, teacher, subjects: await this.subjects.findByIds(link.subjectIds) };
  }
}
