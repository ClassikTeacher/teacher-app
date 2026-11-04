import { Module } from '@nestjs/common';
import { Clock } from '@shared/time/clock.js';
import { AccessModule } from '@modules/access/access.module.js';
import { AuditModule } from '@modules/audit/audit.module.js';
import { IdentityModule } from '@modules/identity/identity.module.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { IcsFeedRepository } from './ics-feed.repository.js';
import { IcsUseCase } from './ics.use-case.js';

const PROVIDERS = [Clock, IcsFeedRepository, IcsUseCase];

/** 7.4 `integrations`: the ICS subscription (M6-04); Google Calendar joins in stage 2. */
@Module({
  imports: [IdentityModule, AccessModule, AuditModule, PeopleModule, ScheduleModule],
  providers: PROVIDERS,
  exports: PROVIDERS,
})
export class IntegrationsModule {}
