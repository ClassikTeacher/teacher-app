import { Module } from '@nestjs/common';
import { Clock } from '@shared/time/clock.js';
import { AccessModule } from '@modules/access/access.module.js';
import { AuditModule } from '@modules/audit/audit.module.js';
import { ContentModule } from '@modules/content/content.module.js';
import { FilesModule } from '@modules/files/files.module.js';
import { IdentityModule } from '@modules/identity/identity.module.js';
import { OutboxModule } from '@modules/outbox/outbox.module.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { AssignmentEventsHandler } from './assignment-events.handler.js';
import { AssignmentRepository } from './assignment.repository.js';
import { AssignmentsUseCase } from './assignments.use-case.js';
import { HomeworkQuery } from './homework.query.js';
import { OverdueAssignmentsJob } from './overdue.job.js';
import { ReviewUseCase } from './review.use-case.js';
import { SubmissionRepository } from './submission.repository.js';
import { SubmitUseCase } from './submit.use-case.js';

const PROVIDERS = [
  Clock,
  AssignmentRepository,
  SubmissionRepository,
  AssignmentsUseCase,
  SubmitUseCase,
  ReviewUseCase,
  HomeworkQuery,
  OverdueAssignmentsJob,
  AssignmentEventsHandler,
];

/** 7.4 `homework`: assignments, submissions, reviews (M5-03, M5-04). */
@Module({
  imports: [
    IdentityModule,
    AccessModule,
    AuditModule,
    OutboxModule,
    PeopleModule,
    ScheduleModule,
    FilesModule,
    ContentModule,
  ],
  providers: PROVIDERS,
  exports: PROVIDERS,
})
export class HomeworkModule {}
