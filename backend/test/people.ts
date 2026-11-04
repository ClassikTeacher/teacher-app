import type { TestContext } from './app.js';
import { InvitationService } from '../libs/modules/identity/invitation.service.js';
import { TeacherStudentRepository } from '../libs/modules/people/links/teacher-student.repository.js';
import type { TeacherStudentRow } from '../libs/modules/people/schema.js';

export const MATH_ID = '019a0000-0000-7000-8000-000000000001';
export const PHYSICS_ID = '019a0000-0000-7000-8000-000000000002';

/** Issues a student invitation with its pending card the way the StaffBot dialog does (UC-10 steps 2–3). */
export async function issueStudentInvitation(
  ctx: TestContext,
  teacherId: string,
  options: { subjectIds?: string[]; maxLessonsPerWeek?: number | null; name?: string; grade?: string } = {},
): Promise<{ token: string; link: TeacherStudentRow }> {
  const invitations = ctx.get(InvitationService);
  const links = ctx.get(TeacherStudentRepository);
  const issued = await invitations.create(
    { kind: 'student', createdBy: teacherId, payload: { teacherId, displayName: options.name } },
    ctx.clock.now(),
  );
  const link = await links.insertPending({
    teacherId,
    invitationId: issued.invitation.id,
    inviteName: options.name ?? null,
    inviteGrade: options.grade ?? null,
    subjectIds: options.subjectIds ?? [MATH_ID],
    maxLessonsPerWeek: options.maxLessonsPerWeek === undefined ? 2 : options.maxLessonsPerWeek,
  });
  return { token: issued.token, link };
}

/** Issues a parent invitation for a student (UC-11 step 2). */
export async function issueParentInvitation(
  ctx: TestContext,
  teacherId: string,
  studentId: string,
): Promise<string> {
  const issued = await ctx
    .get(InvitationService)
    .create({ kind: 'parent', createdBy: teacherId, payload: { teacherId, studentId } }, ctx.clock.now());
  return issued.token;
}

/** An active teacher–student link with an open period, as if the student had accepted an invitation. */
export async function linkStudent(
  ctx: TestContext,
  teacherId: string,
  studentId: string,
  options: { subjectIds?: string[]; maxLessonsPerWeek?: number | null } = {},
): Promise<TeacherStudentRow> {
  const links = ctx.get(TeacherStudentRepository);
  const link = await links.insertActive({
    teacherId,
    studentId,
    subjectIds: options.subjectIds ?? [MATH_ID],
    maxLessonsPerWeek: options.maxLessonsPerWeek === undefined ? 2 : options.maxLessonsPerWeek,
    startedAt: ctx.clock.now(),
  });
  await links.openPeriod(link.id, ctx.clock.now());
  return link;
}
