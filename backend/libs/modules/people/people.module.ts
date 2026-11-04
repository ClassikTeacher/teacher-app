import { Module } from '@nestjs/common';
import { Clock } from '@shared/time/clock.js';
import { AccessModule } from '@modules/access/access.module.js';
import { AuditModule } from '@modules/audit/audit.module.js';
import { IdentityModule } from '@modules/identity/identity.module.js';
import { OutboxModule } from '@modules/outbox/outbox.module.js';
import { CatalogAdminUseCase } from './catalog-admin.use-case.js';
import { AcceptParentInvitationUseCase } from './family/accept-parent-invitation.use-case.js';
import { FamilyLinkRepository } from './family/family-link.repository.js';
import { FamilyQuery } from './family/family.query.js';
import { InviteParentUseCase } from './family/invite-parent.use-case.js';
import { RevokeFamilyLinkUseCase } from './family/revoke-family-link.use-case.js';
import { GroupRepository } from './groups/group.repository.js';
import { GroupsQuery } from './groups/groups.query.js';
import { GroupsUseCase } from './groups/groups.use-case.js';
import { JournalsPort } from './journals.port.js';
import { AcceptStudentInvitationUseCase } from './links/accept-student-invitation.use-case.js';
import { EndLinkUseCase } from './links/end-link.use-case.js';
import { ExpireLeaveRequestsJob } from './links/expire-leave-requests.job.js';
import { InviteStudentUseCase } from './links/invite-student.use-case.js';
import { LeaveRequestRepository } from './links/leave-request.repository.js';
import { LeaveRequestUseCase } from './links/leave-request.use-case.js';
import { TeacherStudentsQuery } from './links/students.query.js';
import { UpdateStudentCardUseCase } from './links/update-student-card.use-case.js';
import { MessageTemplateRepository } from './message-template.repository.js';
import { TeacherSettingsUseCase } from './teacher-settings.use-case.js';
import { TeacherStudentRepository } from './links/teacher-student.repository.js';
import { PersonOnboardingService } from './person-onboarding.service.js';
import { StudentProfileRepository } from './student-profile.repository.js';
import { CompleteStaffOnboardingUseCase } from './complete-staff-onboarding.use-case.js';
import { FileTypeRepository } from './file-type.repository.js';
import { SubjectRepository } from './subject.repository.js';
import { TeacherProfileRepository } from './teacher-profile.repository.js';

const PROVIDERS = [
  Clock,
  SubjectRepository,
  TeacherProfileRepository,
  FileTypeRepository,
  CompleteStaffOnboardingUseCase,
  CatalogAdminUseCase,
  StudentProfileRepository,
  TeacherStudentRepository,
  FamilyLinkRepository,
  JournalsPort,
  PersonOnboardingService,
  AcceptStudentInvitationUseCase,
  AcceptParentInvitationUseCase,
  InviteStudentUseCase,
  TeacherStudentsQuery,
  FamilyQuery,
  InviteParentUseCase,
  RevokeFamilyLinkUseCase,
  UpdateStudentCardUseCase,
  MessageTemplateRepository,
  TeacherSettingsUseCase,
  GroupRepository,
  GroupsUseCase,
  GroupsQuery,
  LeaveRequestRepository,
  EndLinkUseCase,
  LeaveRequestUseCase,
  ExpireLeaveRequestsJob,
];

@Module({
  imports: [IdentityModule, AuditModule, OutboxModule, AccessModule],
  providers: PROVIDERS,
  exports: PROVIDERS,
})
export class PeopleModule {}
