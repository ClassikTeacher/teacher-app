import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AppError } from '@shared/errors/app-error.js';
import { ZodValidationPipe } from '@shared/http/zod-validation.pipe.js';
import { type Actor } from '@modules/access/actor.js';
import { BearerAuthGuard, CurrentActor, RequireRoles } from '@modules/access/http/bearer-auth.guard.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { FamilyQuery } from '@modules/people/family/family.query.js';
import { InviteParentUseCase } from '@modules/people/family/invite-parent.use-case.js';
import { RevokeFamilyLinkUseCase } from '@modules/people/family/revoke-family-link.use-case.js';
import { InviteStudentUseCase } from '@modules/people/links/invite-student.use-case.js';
import {
  cardDisplayName,
  type StudentCard,
  TeacherStudentsQuery,
} from '@modules/people/links/students.query.js';
import { UpdateStudentCardUseCase } from '@modules/people/links/update-student-card.use-case.js';
import type { TeacherStudentRow } from '@modules/people/schema.js';
import { uuidParam } from '../admin/admin.schemas.js';
import {
  type CreateStudentInvitationDto,
  createStudentInvitationSchema,
  type StudentsQueryDto,
  studentsQuerySchema,
  type UpdateStudentDto,
  updateStudentSchema,
} from './students.schemas.js';

function linkView(link: TeacherStudentRow) {
  return {
    id: link.id,
    status: link.status,
    studentId: link.studentId,
    alias: link.alias,
    subjectIds: link.subjectIds,
    maxLessonsPerWeek: link.maxLessonsPerWeek,
    goals: link.goals,
    notes: link.notes,
    calendarOpen: link.calendarOpen,
    startedAt: link.startedAt?.toISOString() ?? null,
    endedAt: link.endedAt?.toISOString() ?? null,
    endReason: link.endReason,
  };
}

function cardView(card: StudentCard) {
  return {
    ...linkView(card.link),
    displayName: cardDisplayName(card),
    student: card.student
      ? {
          id: card.student.id,
          firstName: card.student.firstName,
          lastName: card.student.lastName,
          username: card.student.username,
        }
      : null,
    grade: card.link.status === 'pending' ? (card.link.inviteGrade ?? null) : (card.profile?.grade ?? null),
    school: card.profile?.school ?? null,
    subjects: card.subjects.map((s) => ({ id: s.id, name: s.name })),
  };
}

/** Teacher's students (9.2 "Students", "Parents"); ids are link (card) ids, scoped to the caller by the use-cases. */
@ApiTags('students')
@ApiBearerAuth()
@UseGuards(BearerAuthGuard)
@RequireRoles('TEACHER')
@Controller('students')
export class StudentsController {
  constructor(
    private readonly students: TeacherStudentsQuery,
    private readonly inviteStudent: InviteStudentUseCase,
    private readonly updateCard: UpdateStudentCardUseCase,
    private readonly inviteParent: InviteParentUseCase,
    private readonly revokeFamily: RevokeFamilyLinkUseCase,
    private readonly family: FamilyQuery,
    private readonly familyLinks: FamilyLinkRepository,
  ) {}

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(studentsQuerySchema)) q: StudentsQueryDto,
  ) {
    if (q.status === 'pending') {
      const items = await this.students.listPending(actor.accountId);
      return items.map((i) => ({
        ...linkView(i.link),
        displayName: cardDisplayName({ link: i.link, student: null }),
      }));
    }
    const items =
      q.status === 'ended'
        ? await this.students.listEnded(actor.accountId)
        : await this.students.listActive(actor.accountId);
    return items.map((i) => ({ ...linkView(i.link), displayName: cardDisplayName(i) }));
  }

  @Get(':id')
  async get(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(uuidParam)) id: string) {
    const card = await this.students.card(actor.accountId, id);
    if (!card) throw AppError.notFound('student card', id);
    const parents = card.link.studentId ? await this.family.parentsOf(card.link.studentId) : [];
    return {
      ...cardView(card),
      parents: parents.map((p) => ({
        familyLinkId: p.link.id,
        id: p.parent.id,
        firstName: p.parent.firstName,
        lastName: p.parent.lastName,
        invitedBy: p.link.invitedBy,
      })),
    };
  }

  @Patch(':id')
  async update(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(updateStudentSchema)) body: UpdateStudentDto,
  ) {
    await this.updateCard.execute(actor, id, body);
    const card = await this.students.card(actor.accountId, id);
    if (!card) throw AppError.notFound('student card', id);
    return cardView(card);
  }

  @Post('invitations')
  async invite(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createStudentInvitationSchema)) body: CreateStudentInvitationDto,
  ) {
    const { link, issued } = await this.inviteStudent.execute(actor, body);
    return { ...linkView(link), link: issued.link, expiresAt: issued.invitation.expiresAt.toISOString() };
  }

  @Post(':id/parents/invitations')
  async inviteParentTo(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
  ) {
    const issued = await this.inviteParent.execute(actor, id);
    return {
      id: issued.invitation.id,
      link: issued.link,
      expiresAt: issued.invitation.expiresAt.toISOString(),
    };
  }

  /** The inviting teacher (or an admin) revokes a parent of this student (5.4.3). */
  @Delete(':id/parents/:parentId')
  @HttpCode(200)
  async removeParent(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Param('parentId', new ZodValidationPipe(uuidParam)) parentId: string,
  ) {
    const card = await this.students.card(actor.accountId, id);
    if (!card?.link.studentId) throw AppError.notFound('student card', id);
    const link = await this.familyLinks.findActive(parentId, card.link.studentId);
    if (!link) throw AppError.notFound('family link');
    const revoked = await this.revokeFamily.execute(actor, link.id);
    return { familyLinkId: revoked.id, status: revoked.status };
  }
}
