import { Module } from '@nestjs/common';
import { Clock } from '@shared/time/clock.js';
import { AccessModule } from '@modules/access/access.module.js';
import { AuditModule } from '@modules/audit/audit.module.js';
import { IdentityModule } from '@modules/identity/identity.module.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { OutboxModule } from '@modules/outbox/outbox.module.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { GOOGLE_API } from './google/google-api.js';
import { GoogleApiHttp } from './google/google-api.http.js';
import { GoogleCalendarRepository } from './google/google-calendar.repository.js';
import { GoogleCalendarUseCase } from './google/google-calendar.use-case.js';
import { GoogleEventsHandler } from './google/google-events.handler.js';
import { GoogleSyncJob } from './google/google-sync.job.js';
import { GoogleSyncService } from './google/google-sync.service.js';
import { IcsFeedRepository } from './ics-feed.repository.js';
import { IcsUseCase } from './ics.use-case.js';

const PROVIDERS = [
  Clock,
  IcsFeedRepository,
  IcsUseCase,
  { provide: GOOGLE_API, useClass: GoogleApiHttp },
  GoogleCalendarRepository,
  GoogleCalendarUseCase,
  GoogleSyncService,
  GoogleSyncJob,
  GoogleEventsHandler,
];

/** 7.4 `integrations`: the ICS subscription (M6-04) and Google Calendar (E2-05). */
@Module({
  imports: [
    IdentityModule,
    AccessModule,
    AuditModule,
    OutboxModule,
    NotificationsModule,
    PeopleModule,
    ScheduleModule,
  ],
  providers: PROVIDERS,
  exports: PROVIDERS,
})
export class IntegrationsModule {}
