import { Body, Controller, Delete, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '@shared/http/zod-validation.pipe.js';
import { type Actor } from '@modules/access/actor.js';
import { BearerAuthGuard, CurrentActor, RequireRoles } from '@modules/access/http/bearer-auth.guard.js';
import { AdminRoleUseCase } from '@modules/identity/admin-role.use-case.js';
import { BlockAccountUseCase } from '@modules/identity/block-account.use-case.js';
import { InviteStaffUseCase } from '@modules/identity/invite-staff.use-case.js';
import {
  type BlockUserDto,
  blockUserSchema,
  type CreateInvitationDto,
  createInvitationSchema,
  type GrantAdminDto,
  grantAdminSchema,
  uuidParam,
} from './admin.schemas.js';

/** Admin REST (9.2 "Admin"); every call is also checked inside the use-cases. */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(BearerAuthGuard)
@RequireRoles('ADMIN', 'SUPER_ADMIN')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly inviteStaff: InviteStaffUseCase,
    private readonly blockAccount: BlockAccountUseCase,
    private readonly adminRole: AdminRoleUseCase,
  ) {}

  @Post('invitations')
  async createInvitation(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createInvitationSchema)) body: CreateInvitationDto,
  ) {
    const issued = await this.inviteStaff.execute(actor, body);
    return {
      id: issued.invitation.id,
      kind: issued.invitation.kind,
      link: issued.link,
      expiresAt: issued.invitation.expiresAt.toISOString(),
    };
  }

  @Delete('invitations/:id')
  @HttpCode(200)
  async revokeInvitation(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
  ) {
    const row = await this.inviteStaff.revoke(actor, id);
    return { id: row.id, status: row.status };
  }

  @Post('users/:id/block')
  @HttpCode(200)
  async block(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(blockUserSchema)) body: BlockUserDto,
  ) {
    const row = await this.blockAccount.block(actor, id, body);
    return { id: row.id, status: row.status, blockedAt: row.blockedAt?.toISOString() ?? null };
  }

  @Post('users/:id/unblock')
  @HttpCode(200)
  async unblock(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(uuidParam)) id: string) {
    const row = await this.blockAccount.unblock(actor, id);
    return { id: row.id, status: row.status };
  }

  @Post('admins')
  @RequireRoles('SUPER_ADMIN')
  async grantAdmin(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(grantAdminSchema)) body: GrantAdminDto,
  ) {
    await this.adminRole.grant(actor, body.accountId);
    return { accountId: body.accountId, role: 'ADMIN' };
  }

  @Delete('admins/:accountId')
  @RequireRoles('SUPER_ADMIN')
  @HttpCode(200)
  async revokeAdmin(
    @CurrentActor() actor: Actor,
    @Param('accountId', new ZodValidationPipe(uuidParam)) accountId: string,
  ) {
    await this.adminRole.revoke(actor, accountId);
    return { accountId, role: null };
  }
}
