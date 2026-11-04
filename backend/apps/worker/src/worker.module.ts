import { Module } from '@nestjs/common';
import { ConfigModule } from '@shared/config/index.js';
import { DbModule } from '@shared/db/index.js';
import { LoggerModule } from '@shared/logging/index.js';
import { QueueModule } from '@shared/queue/index.js';
import { RedisModule } from '@shared/redis/index.js';
import { S3Module } from '@shared/s3/index.js';
import { Clock } from '@shared/time/index.js';
import { AccessModule } from '@modules/access/access.module.js';
import { ContentModule } from '@modules/content/content.module.js';
import { HomeworkModule } from '@modules/homework/homework.module.js';
import { FilesModule } from '@modules/files/files.module.js';
import { IdentityModule } from '@modules/identity/identity.module.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { OutboxModule } from '@modules/outbox/outbox.module.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { BotApiModule } from '@telegram/api/bot-api.module.js';
import { WorkerRunner } from './worker.runner.js';

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    DbModule,
    RedisModule,
    S3Module,
    QueueModule,
    BotApiModule,
    IdentityModule,
    AccessModule,
    OutboxModule,
    FilesModule,
    ContentModule,
    HomeworkModule,
    PeopleModule,
    ScheduleModule,
    NotificationsModule,
  ],
  providers: [Clock, WorkerRunner],
})
export class WorkerModule {}
