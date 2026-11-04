import { Module } from '@nestjs/common';
import { ConfigModule } from '@shared/config/index.js';
import { DbModule } from '@shared/db/index.js';
import { RedisModule } from '@shared/redis/index.js';
import { S3Module } from '@shared/s3/index.js';
import { LoggerModule } from '@shared/logging/index.js';
import { Clock } from '@shared/time/index.js';
import { AccessModule } from '@modules/access/access.module.js';
import { AuditModule } from '@modules/audit/audit.module.js';
import { ContentModule } from '@modules/content/content.module.js';
import { HomeworkModule } from '@modules/homework/homework.module.js';
import { FilesModule } from '@modules/files/files.module.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { IdentityModule } from '@modules/identity/identity.module.js';
import { TelegramModule } from '@telegram/telegram.module.js';
import { AdminController } from './admin/admin.controller.js';
import { AuditController } from './admin/audit.controller.js';
import { CatalogController } from './admin/catalog.controller.js';
import { FeaturesController } from './admin/features.controller.js';
import { SystemController } from './system/system.controller.js';
import { WebhookController } from './telegram/webhook.controller.js';
import { HealthController } from './health.controller.js';
import { AvailabilityController } from './calendar/availability.controller.js';
import { CalendarController } from './calendar/calendar.controller.js';
import { LessonsController } from './lessons/lessons.controller.js';
import { RequestsController } from './requests/requests.controller.js';
import { GroupsController } from './groups/groups.controller.js';
import { MeController } from './me/me.controller.js';
import { StudentsController } from './students/students.controller.js';
import { ContentController } from './content/content.controller.js';
import { HomeworkController } from './homework/homework.controller.js';
import { GradebookModule } from '@modules/gradebook/gradebook.module.js';
import { GradebookController } from './gradebook/gradebook.controller.js';
import { ReportsController } from './gradebook/reports.controller.js';

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    DbModule,
    RedisModule,
    S3Module,
    IdentityModule,
    AccessModule,
    AuditModule,
    PeopleModule,
    FilesModule,
    ContentModule,
    HomeworkModule,
    GradebookModule,
    ScheduleModule,
    TelegramModule,
  ],
  controllers: [
    HealthController,
    AdminController,
    FeaturesController,
    AuditController,
    CatalogController,
    SystemController,
    WebhookController,
    MeController,
    StudentsController,
    GroupsController,
    CalendarController,
    AvailabilityController,
    LessonsController,
    RequestsController,
    ContentController,
    HomeworkController,
    GradebookController,
    ReportsController,
  ],
  providers: [Clock],
})
export class ApiModule {}
