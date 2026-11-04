import { Module } from '@nestjs/common';
import { Clock } from '@shared/time/clock.js';
import { AccessModule } from '@modules/access/access.module.js';
import { AuditModule } from '@modules/audit/audit.module.js';
import { FilesModule } from '@modules/files/files.module.js';
import { IdentityModule } from '@modules/identity/identity.module.js';
import { OutboxModule } from '@modules/outbox/outbox.module.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { ContentAccessQuery } from './content-access.query.js';
import { GrantRepository } from './grant.repository.js';
import { GrantsUseCase } from './grants.use-case.js';
import { LessonContentHandler } from './lesson-content.handler.js';
import { MaterialRepository } from './material.repository.js';
import { MaterialsQuery } from './materials.query.js';
import { MaterialsUseCase } from './materials.use-case.js';

const PROVIDERS = [
  Clock,
  MaterialRepository,
  GrantRepository,
  GrantsUseCase,
  MaterialsUseCase,
  MaterialsQuery,
  ContentAccessQuery,
  LessonContentHandler,
];

/** 7.4 `content`: materials, collections, grants (M5-02). */
@Module({
  imports: [
    IdentityModule,
    AccessModule,
    AuditModule,
    OutboxModule,
    PeopleModule,
    FilesModule,
    ScheduleModule,
  ],
  providers: PROVIDERS,
  exports: PROVIDERS,
})
export class ContentModule {}
