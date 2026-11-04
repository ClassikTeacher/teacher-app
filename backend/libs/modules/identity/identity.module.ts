import { Module } from '@nestjs/common';
import { Clock } from '@shared/time/clock.js';
import { AuditModule } from '@modules/audit/audit.module.js';
import { OutboxModule } from '@modules/outbox/outbox.module.js';
import { AccountRepository } from './account.repository.js';
import { ActorResolver } from './actor-resolver.js';
import { AdminRoleUseCase } from './admin-role.use-case.js';
import { BlockAccountUseCase } from './block-account.use-case.js';
import { BootstrapSuperAdminService } from './bootstrap-super-admin.service.js';
import { ExpireInvitationsJob } from './expire-invitations.job.js';
import { InvitationRepository } from './invitation.repository.js';
import { InvitationService } from './invitation.service.js';
import { InviteStaffUseCase } from './invite-staff.use-case.js';
import { RedeemStaffInvitationUseCase } from './redeem-staff-invitation.use-case.js';
import { SuperAdminTransferUseCase } from './super-admin-transfer.use-case.js';

const PROVIDERS = [
  Clock,
  AccountRepository,
  InvitationRepository,
  InvitationService,
  ActorResolver,
  InviteStaffUseCase,
  RedeemStaffInvitationUseCase,
  BlockAccountUseCase,
  AdminRoleUseCase,
  BootstrapSuperAdminService,
  ExpireInvitationsJob,
  SuperAdminTransferUseCase,
];

@Module({
  imports: [AuditModule, OutboxModule],
  providers: PROVIDERS,
  exports: PROVIDERS,
})
export class IdentityModule {}
