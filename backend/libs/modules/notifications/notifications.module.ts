import { Module } from '@nestjs/common';
import { Clock } from '@shared/time/clock.js';
import { AccessModule } from '@modules/access/access.module.js';
import { AuditModule } from '@modules/audit/audit.module.js';
import { IdentityModule } from '@modules/identity/identity.module.js';
import { OutboxModule } from '@modules/outbox/outbox.module.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { BotApiModule } from '@telegram/api/bot-api.module.js';
import { ContentModule } from '@modules/content/content.module.js';
import { ContentEventsHandler } from './handlers/content-events.handler.js';
import { FilesModule } from '@modules/files/files.module.js';
import { HomeworkModule } from '@modules/homework/homework.module.js';
import { HomeworkEventsHandler } from './handlers/homework-events.handler.js';
import { GradebookModule } from '@modules/gradebook/gradebook.module.js';
import { GradeEventsHandler } from './handlers/grade-events.handler.js';
import { ChannelEventsHandler } from './handlers/channel-events.handler.js';
import { DailyDigestJob } from './digest.job.js';
import { NotificationPrefsRepository } from './notification-prefs.repository.js';
import { NotificationSettingsUseCase } from './notification-settings.use-case.js';
import { RescheduleEventsHandler } from './handlers/reschedule-events.handler.js';
import { CancellationEventsHandler } from './handlers/cancellation-events.handler.js';
import { AdminEventsHandler } from './handlers/admin-events.handler.js';
import { FamilyEventsHandler } from './handlers/family-events.handler.js';
import { LessonEventsHandler } from './handlers/lesson-events.handler.js';
import { LinkEventsHandler } from './handlers/link-events.handler.js';
import { PeopleEventsHandler } from './handlers/people-events.handler.js';
import { SecurityEventsHandler } from './handlers/security-events.handler.js';
import { NotificationRepository } from './notification.repository.js';
import { NotificationScheduler } from './notification.scheduler.js';
import { NotificationSender } from './notification.sender.js';
import { NotificationService } from './notification.service.js';

const PROVIDERS = [
  Clock,
  NotificationRepository,
  NotificationService,
  NotificationScheduler,
  NotificationSender,
  AdminEventsHandler,
  SecurityEventsHandler,
  PeopleEventsHandler,
  FamilyEventsHandler,
  LinkEventsHandler,
  LessonEventsHandler,
  CancellationEventsHandler,
  RescheduleEventsHandler,
  ChannelEventsHandler,
  ContentEventsHandler,
  HomeworkEventsHandler,
  GradeEventsHandler,
  NotificationPrefsRepository,
  NotificationSettingsUseCase,
  DailyDigestJob,
];

@Module({
  imports: [
    IdentityModule,
    AccessModule,
    AuditModule,
    OutboxModule,
    BotApiModule,
    PeopleModule,
    ScheduleModule,
    ContentModule,
    HomeworkModule,
    FilesModule,
    GradebookModule,
  ],
  providers: PROVIDERS,
  exports: PROVIDERS,
})
export class NotificationsModule {}
