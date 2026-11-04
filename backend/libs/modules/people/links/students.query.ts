import { Injectable } from '@nestjs/common';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { InvitationRepository } from '@modules/identity/invitation.repository.js';
import type { AccountRow, InvitationRow } from '@modules/identity/schema.js';
import type { StudentProfileRow, SubjectRow, TeacherStudentRow } from '../schema.js';
import { StudentProfileRepository } from '../student-profile.repository.js';
import { SubjectRepository } from '../subject.repository.js';
import { TeacherStudentRepository } from './teacher-student.repository.js';

export interface StudentListItem {
  link: TeacherStudentRow;
  student: AccountRow | null;
}

export interface PendingCardItem {
  link: TeacherStudentRow;
  invitation: InvitationRow | null;
}

/** Everything the student card screen shows (5.4.1). */
export interface StudentCard {
  link: TeacherStudentRow;
  student: AccountRow | null;
  profile: StudentProfileRow | null;
  subjects: SubjectRow[];
  invitation: InvitationRow | null;
}

/** How a teacher sees a card: alias first, then the account name, then the name typed at invitation. */
export function cardDisplayName(item: { link: TeacherStudentRow; student: AccountRow | null }): string {
  if (item.link.alias?.trim()) return item.link.alias.trim();
  if (item.student) return `${item.student.firstName} ${item.student.lastName}`.trim() || '—';
  return item.link.inviteName?.trim() || '—';
}

/** Read side of the teacher's "Ученики" section; ownership is enforced by filtering on teacher_id. */
@Injectable()
export class TeacherStudentsQuery {
  constructor(
    private readonly links: TeacherStudentRepository,
    private readonly accounts: AccountRepository,
    private readonly profiles: StudentProfileRepository,
    private readonly subjects: SubjectRepository,
    private readonly invitations: InvitationRepository,
  ) {}

  async listActive(teacherId: string): Promise<StudentListItem[]> {
    return this.withStudents(await this.links.listByTeacher(teacherId, ['active']));
  }

  async listEnded(teacherId: string): Promise<StudentListItem[]> {
    return this.withStudents(await this.links.listByTeacher(teacherId, ['ended']));
  }

  /** Cards awaiting acceptance plus declined ones, so the teacher can re-issue or withdraw them. */
  async listPending(teacherId: string): Promise<PendingCardItem[]> {
    const links = await this.links.listByTeacher(teacherId, ['pending', 'declined']);
    const ids = links.map((l) => l.invitationId).filter((id): id is string => id !== null);
    const byId = new Map((await this.invitations.findByIds(ids)).map((i) => [i.id, i]));
    return links.map((link) => ({
      link,
      invitation: link.invitationId ? (byId.get(link.invitationId) ?? null) : null,
    }));
  }

  async counts(teacherId: string): Promise<{ active: number; pending: number; ended: number }> {
    const [active, pending, ended] = await Promise.all([
      this.links.countByTeacher(teacherId, ['active']),
      this.links.countByTeacher(teacherId, ['pending', 'declined']),
      this.links.countByTeacher(teacherId, ['ended']),
    ]);
    return { active, pending, ended };
  }

  /** Null when the card does not exist or belongs to another teacher (8.0). */
  async card(teacherId: string, linkId: string): Promise<StudentCard | null> {
    const link = await this.links.findById(linkId);
    if (!link || link.teacherId !== teacherId) return null;
    const [student, profile, subjects, invitation] = await Promise.all([
      link.studentId ? this.accounts.findById(link.studentId) : null,
      link.studentId ? this.profiles.find(link.studentId) : null,
      this.subjects.findByIds(link.subjectIds),
      link.invitationId ? this.invitations.findById(link.invitationId) : null,
    ]);
    return { link, student, profile, subjects, invitation };
  }

  private async withStudents(links: TeacherStudentRow[]): Promise<StudentListItem[]> {
    const ids = links.map((l) => l.studentId).filter((id): id is string => id !== null);
    const students = new Map((await this.accounts.findByIds(ids)).map((a) => [a.id, a]));
    return links
      .map((link) => ({ link, student: link.studentId ? (students.get(link.studentId) ?? null) : null }))
      .sort((a, b) => cardDisplayName(a).localeCompare(cardDisplayName(b), 'ru'));
  }
}
