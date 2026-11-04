import { Module } from '@nestjs/common';
import { Clock } from '@shared/time/clock.js';
import { AccessModule } from '@modules/access/access.module.js';
import { AuditModule } from '@modules/audit/audit.module.js';
import { FilesModule } from '@modules/files/files.module.js';
import { HomeworkModule } from '@modules/homework/homework.module.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { IdentityModule } from '@modules/identity/identity.module.js';
import { OutboxModule } from '@modules/outbox/outbox.module.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { GradeEntriesUseCase } from './grade-entries.use-case.js';
import { GradeEntryRepository } from './grade-entry.repository.js';
import { GradebookQuery } from './gradebook.query.js';
import { JournalRepository } from './journal.repository.js';
import { JournalsUseCase } from './journals.use-case.js';
import { ReportRepository } from './report.repository.js';
import { ReportsUseCase } from './reports.use-case.js';

const PROVIDERS = [
  Clock,
  JournalRepository,
  GradeEntryRepository,
  JournalsUseCase,
  GradeEntriesUseCase,
  GradebookQuery,
  ReportRepository,
  ReportsUseCase,
];

/** 7.4 `gradebook`: journals, scales, records, statistics and reports (M6-01…M6-03). */
@Module({
  imports: [
    IdentityModule,
    AccessModule,
    AuditModule,
    OutboxModule,
    PeopleModule,
    FilesModule,
    ScheduleModule,
    HomeworkModule,
  ],
  providers: PROVIDERS,
  exports: PROVIDERS,
})
export class GradebookModule {}
