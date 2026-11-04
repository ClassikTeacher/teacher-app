import { Module } from '@nestjs/common';
import { Clock } from '@shared/time/clock.js';
import { AccessModule } from '@modules/access/access.module.js';
import { IdentityModule } from '@modules/identity/identity.module.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { ContentModule } from '@modules/content/content.module.js';
import { HomeworkModule } from '@modules/homework/homework.module.js';
import { FilesModule } from '@modules/files/files.module.js';
import { AuthBot } from './auth-bot/auth-bot.js';
import { OnboardingFlow } from './auth-bot/onboarding.flow.js';
import { BOT_DEFINITIONS, type BotDefinition } from './gateway/bot-definition.js';
import { TelegramGateway } from './gateway/telegram.gateway.js';
import { ChildrenSection } from './parent-bot/children.section.js';
import { ParentOnboardingFlow } from './parent-bot/onboarding.flow.js';
import { ParentBot } from './parent-bot/parent-bot.js';
import { PARENT_SECTION_MODULES } from './parent-bot/sections.js';
import { StudentOnboardingFlow } from './student-bot/onboarding.flow.js';
import { STUDENT_SECTION_MODULES } from './student-bot/sections.js';
import { StudentBot } from './student-bot/student-bot.js';
import { StudentTeachersSection } from './student-bot/teachers.section.js';
import { AdminsSection } from './staff-bot/admin/admins.section.js';
import { BlockAccountFlow } from './staff-bot/admin/block-account.flow.js';
import { FeaturesSection } from './staff-bot/admin/features.section.js';
import { FileTypesSection } from './staff-bot/admin/filetypes.section.js';
import { InvitationsSection } from './staff-bot/admin/invitations.section.js';
import { InviteTeacherFlow } from './staff-bot/admin/invite-teacher.flow.js';
import { LimitEditFlow } from './staff-bot/admin/limit-edit.flow.js';
import { TeachersSection } from './staff-bot/admin/teachers.section.js';
import { AddSubjectFlow, SubjectsSection } from './staff-bot/admin/subjects.section.js';
import { UserSearchFlow, UsersSection } from './staff-bot/admin/users.section.js';
import { STAFF_SECTIONS, type StaffSectionModule } from './staff-bot/section-module.js';
import { StaffBot } from './staff-bot/staff-bot.js';
import { InviteStudentFlow } from './staff-bot/students/invite-student.flow.js';
import { CreateGroupFlow } from './staff-bot/groups/create-group.flow.js';
import { GroupsSection } from './staff-bot/groups/groups.section.js';
import { SettingEditFlow } from './staff-bot/settings/setting-edit.flow.js';
import { SettingsSection } from './staff-bot/settings/settings.section.js';
import { CardEditFlow } from './staff-bot/students/card-edit.flow.js';
import { CardEditScreen } from './staff-bot/students/card-edit.screen.js';
import { EndLinkFlow } from './staff-bot/students/end-link.flow.js';
import { ParentsScreen } from './staff-bot/students/parents.screen.js';
import { StudentsSection } from './staff-bot/students/students.section.js';
import { StudentParentsSection } from './student-bot/parents.section.js';
import { ParentTeachersSection } from './parent-bot/teachers.section.js';
import { ParentEndLinkFlow } from './parent-bot/end-link.flow.js';
import { RequestsSection } from './parent-bot/requests.section.js';
import { StudentArchiveSection } from './student-bot/archive.section.js';
import { LeaveFlow } from './student-bot/leave.flow.js';
import { StudentScheduleSection } from './student-bot/schedule.section.js';
import { ParentScheduleSection } from './parent-bot/schedule.section.js';
import { AddBlockFlow } from './staff-bot/schedule/add-block.flow.js';
import { TodaySection } from './staff-bot/schedule/today.section.js';
import { CreateLessonFlow } from './staff-bot/schedule/create-lesson.flow.js';
import { LessonSection } from './staff-bot/schedule/lesson.section.js';
import { CreateSeriesFlow } from './staff-bot/schedule/create-series.flow.js';
import { PauseSeriesFlow } from './staff-bot/schedule/pause-series.flow.js';
import { SeriesScreen } from './staff-bot/schedule/series.screen.js';
import { AttentionSection } from './staff-bot/schedule/attention.section.js';
import { LessonReportFlow } from './staff-bot/schedule/lesson-report.flow.js';
import { AddExceptionFlow } from './staff-bot/settings/add-exception.flow.js';
import { AddRuleFlow } from './staff-bot/settings/add-rule.flow.js';
import { WindowsScreen } from './staff-bot/settings/windows.screen.js';
import { PersonCancelLessonFlow } from './person/cancel-lesson.flow.js';
import { PersonBulkCancelFlow } from './person/bulk-cancel.flow.js';
import { TeacherBulkCancelFlow } from './staff-bot/schedule/bulk-cancel.flow.js';
import { StudentCancelSection } from './student-bot/cancel.section.js';
import { RescheduleLessonFlow } from './staff-bot/schedule/reschedule-lesson.flow.js';
import { DeclineRequestFlow } from './staff-bot/schedule/decline-request.flow.js';
import { RequestsScreen } from './staff-bot/schedule/requests.screen.js';
import { RescheduleRequestFlow } from './person/reschedule-request.flow.js';
import { MoveObjectionFlow } from './person/move-objection.flow.js';
import { BookSlotFlow } from './person/book-slot.flow.js';
import { StudentBookingSection } from './student-bot/booking.section.js';
import { BookingSettingsScreen } from './staff-bot/settings/booking.screen.js';
import { NotificationEditFlow } from './person/notification-edit.flow.js';
import { NotificationSettingsScreen } from './person/notification-settings.screen.js';
import { StudentSettingsSection } from './student-bot/settings.section.js';
import { ParentSettingsSection } from './parent-bot/settings.section.js';
import { StudentCcScreen } from './staff-bot/students/cc.screen.js';
import { TeacherCancelLessonFlow } from './staff-bot/schedule/cancel-lesson.flow.js';
import { MaterialsSection } from './staff-bot/materials/materials.section.js';
import { UploadMaterialFlow } from './staff-bot/materials/upload-material.flow.js';
import { AddMaterialFlow } from './staff-bot/materials/add-material.flow.js';
import { GrantFlow } from './staff-bot/materials/grant.flow.js';
import { CreateCollectionFlow } from './staff-bot/materials/create-collection.flow.js';
import { StudentMaterialsSection } from './student-bot/materials.section.js';
import { AssignmentsSection } from './staff-bot/assignments/assignments.section.js';
import { CreateAssignmentFlow } from './staff-bot/assignments/create-assignment.flow.js';
import { ReviewFlow } from './staff-bot/assignments/review.flow.js';
import { StudentAssignmentsSection } from './student-bot/assignments.section.js';
import { SubmitFlow } from './student-bot/submit.flow.js';
import { ParentAssignmentsSection } from './parent-bot/assignments.section.js';

const FLOWS = [
  OnboardingFlow,
  InviteTeacherFlow,
  BlockAccountFlow,
  LimitEditFlow,
  UserSearchFlow,
  AddSubjectFlow,
  InviteStudentFlow,
  CardEditFlow,
  SettingEditFlow,
  CreateGroupFlow,
  EndLinkFlow,
  LeaveFlow,
  ParentEndLinkFlow,
  StudentOnboardingFlow,
  ParentOnboardingFlow,
  AddBlockFlow,
  CreateLessonFlow,
  CreateSeriesFlow,
  PauseSeriesFlow,
  LessonReportFlow,
  AddRuleFlow,
  AddExceptionFlow,
  PersonCancelLessonFlow,
  TeacherCancelLessonFlow,
  PersonBulkCancelFlow,
  TeacherBulkCancelFlow,
  RescheduleLessonFlow,
  DeclineRequestFlow,
  RescheduleRequestFlow,
  MoveObjectionFlow,
  BookSlotFlow,
  NotificationEditFlow,
  UploadMaterialFlow,
  AddMaterialFlow,
  GrantFlow,
  CreateCollectionFlow,
  CreateAssignmentFlow,
  ReviewFlow,
  SubmitFlow,
];
const SECTIONS = [
  TodaySection,
  LessonSection,
  AttentionSection,
  StudentsSection,
  SettingsSection,
  GroupsSection,
  TeachersSection,
  InvitationsSection,
  FeaturesSection,
  AdminsSection,
  UsersSection,
  SubjectsSection,
  FileTypesSection,
  MaterialsSection,
  AssignmentsSection,
];
const STUDENT_SECTIONS = [
  StudentScheduleSection,
  StudentTeachersSection,
  StudentParentsSection,
  StudentArchiveSection,
  StudentCancelSection,
  StudentBookingSection,
  StudentSettingsSection,
  StudentMaterialsSection,
  StudentAssignmentsSection,
];
const PARENT_SECTIONS = [
  ChildrenSection,
  ParentScheduleSection,
  ParentTeachersSection,
  RequestsSection,
  ParentSettingsSection,
  ParentAssignmentsSection,
];
const BOTS = [AuthBot, StaffBot, StudentBot, ParentBot];

@Module({
  imports: [
    IdentityModule,
    PeopleModule,
    AccessModule,
    ScheduleModule,
    NotificationsModule,
    FilesModule,
    ContentModule,
    HomeworkModule,
  ],
  providers: [
    Clock,
    ...FLOWS,
    ParentsScreen,
    CardEditScreen,
    WindowsScreen,
    SeriesScreen,
    RequestsScreen,
    BookingSettingsScreen,
    NotificationSettingsScreen,
    StudentCcScreen,
    ...SECTIONS,
    {
      provide: STAFF_SECTIONS,
      inject: SECTIONS,
      useFactory: (...sections: StaffSectionModule[]) => sections,
    },
    ...STUDENT_SECTIONS,
    {
      provide: STUDENT_SECTION_MODULES,
      inject: STUDENT_SECTIONS,
      useFactory: (...sections: unknown[]) => sections,
    },
    ...PARENT_SECTIONS,
    {
      provide: PARENT_SECTION_MODULES,
      inject: PARENT_SECTIONS,
      useFactory: (...sections: unknown[]) => sections,
    },
    ...BOTS,
    { provide: BOT_DEFINITIONS, inject: BOTS, useFactory: (...bots: BotDefinition[]) => bots },
    TelegramGateway,
  ],
  exports: [TelegramGateway],
})
export class TelegramModule {}
