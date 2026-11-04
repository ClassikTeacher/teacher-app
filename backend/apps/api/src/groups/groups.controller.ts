import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '@shared/http/zod-validation.pipe.js';
import { type Actor } from '@modules/access/actor.js';
import { BearerAuthGuard, CurrentActor, RequireRoles } from '@modules/access/http/bearer-auth.guard.js';
import { type GroupDetails, GroupsQuery } from '@modules/people/groups/groups.query.js';
import { GroupsUseCase } from '@modules/people/groups/groups.use-case.js';
import type { StudyGroupRow } from '@modules/people/schema.js';
import { uuidParam } from '../admin/admin.schemas.js';

const groupBody = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    subjectId: z.string().uuid().nullable().optional(),
    emoji: z.string().trim().min(1).max(8).nullable().optional(),
    defaultDurationMin: z.number().int().min(15).max(480).nullable().optional(),
  })
  .strict();
const createGroupSchema = groupBody.required({ name: true });
const memberSchema = z.object({ studentId: z.string().uuid() });

function view(g: StudyGroupRow) {
  return {
    id: g.id,
    name: g.name,
    subjectId: g.subjectId,
    emoji: g.emoji,
    defaultDurationMin: g.defaultDurationMin,
    archivedAt: g.archivedAt?.toISOString() ?? null,
  };
}

function detailsView(d: GroupDetails) {
  return {
    ...view(d.group),
    subject: d.subject ? { id: d.subject.id, name: d.subject.name } : null,
    members: d.members.map((m) => ({
      studentId: m.student.id,
      linkId: m.link.id,
      displayName: m.displayName,
      joinedAt: m.member.joinedAt.toISOString(),
    })),
  };
}

/** Groups of the calling teacher (9.2 "Groups"); membership changes apply to future lessons in M3-02. */
@ApiTags('groups')
@ApiBearerAuth()
@UseGuards(BearerAuthGuard)
@RequireRoles('TEACHER')
@Controller('groups')
export class GroupsController {
  constructor(
    private readonly groups: GroupsUseCase,
    private readonly query: GroupsQuery,
  ) {}

  @Get()
  async list(@CurrentActor() actor: Actor) {
    const items = await this.query.listActive(actor.accountId);
    return items.map((i) => ({ ...view(i.group), memberCount: i.memberCount }));
  }

  @Post()
  async create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createGroupSchema)) body: z.infer<typeof createGroupSchema>,
  ) {
    return view(await this.groups.create(actor, body));
  }

  @Get(':id')
  async get(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(uuidParam)) id: string) {
    return detailsView(await this.query.details(actor.accountId, id));
  }

  @Patch(':id')
  async update(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(groupBody)) body: z.infer<typeof groupBody>,
  ) {
    return view(await this.groups.update(actor, id, body));
  }

  @Post(':id/members')
  async addMember(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(memberSchema)) body: z.infer<typeof memberSchema>,
  ) {
    await this.groups.addMember(actor, id, body.studentId);
    return detailsView(await this.query.details(actor.accountId, id));
  }

  @Delete(':id/members/:studentId')
  @HttpCode(200)
  async removeMember(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Param('studentId', new ZodValidationPipe(uuidParam)) studentId: string,
  ) {
    await this.groups.removeMember(actor, id, studentId);
    return detailsView(await this.query.details(actor.accountId, id));
  }

  @Post(':id/archive')
  @HttpCode(200)
  async archive(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(uuidParam)) id: string) {
    return view(await this.groups.archive(actor, id));
  }
}
