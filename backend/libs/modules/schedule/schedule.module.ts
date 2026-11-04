import { Module } from '@nestjs/common';
import { Clock } from '@shared/time/clock.js';
import { AccessModule } from '@modules/access/access.module.js';
import { AuditModule } from '@modules/audit/audit.module.js';
import { IdentityModule } from '@modules/identity/identity.module.js';
import { OutboxModule } from '@modules/outbox/outbox.module.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { BookSlotUseCase } from './booking/book-slot.use-case.js';
import { WeeklyLimitPolicy } from './booking/weekly-limit.policy.js';
import { BookingRequestRepository } from './requests/booking-request.repository.js';
import { RescheduleLessonUseCase } from './reschedule/reschedule-lesson.use-case.js';
import { RescheduleRequestUseCase } from './reschedule/reschedule-request.use-case.js';
import { AutoCancelHandler } from './cancellations/auto-cancel.handler.js';
import { BulkCancelUseCase } from './cancellations/bulk-cancel.use-case.js';
import { CancelLessonUseCase } from './cancellations/cancel-lesson.use-case.js';
import { CancelTemplatesQuery } from './cancellations/cancel-templates.query.js';
import { CancellationRepository } from './cancellations/cancellation.repository.js';
import { AvailabilityRepository } from './availability/availability.repository.js';
import { AvailabilityUseCase } from './availability/availability.use-case.js';
import { OpenSlotsQuery } from './availability/open-slots.query.js';
import { DayViewQuery } from './day-view.query.js';
import { CreateLessonUseCase } from './lessons/create-lesson.use-case.js';
import { GroupMembershipHandler } from './lessons/group-membership.handler.js';
import { LessonLifecycleJob } from './lessons/lesson-lifecycle.job.js';
import { LessonReportUseCase } from './lessons/lesson-report.use-case.js';
import { LessonRepository } from './lessons/lesson.repository.js';
import { LessonSlotsQuery } from './lessons/lesson-slots.query.js';
import { LessonsQuery } from './lessons/lessons.query.js';
import { PersonScheduleQuery } from './lessons/person-schedule.query.js';
import { WindowsPolicy } from './lessons/windows.policy.js';
import { SeriesInstancesService } from './series/series-instances.service.js';
import { SeriesMaterializer } from './series/series.materializer.js';
import { SeriesRepository } from './series/series.repository.js';
import { SeriesUseCase } from './series/series.use-case.js';
import { BusyQuery } from './occupancy/busy.query.js';
import { OccupancyRepository } from './occupancy/occupancy.repository.js';
import { OccupancyService } from './occupancy/occupancy.service.js';
import { PersonalBlockRepository } from './occupancy/personal-block.repository.js';
import { PersonalBlockUseCase } from './occupancy/personal-block.use-case.js';

const PROVIDERS = [
  Clock,
  OccupancyRepository,
  OccupancyService,
  PersonalBlockRepository,
  PersonalBlockUseCase,
  BusyQuery,
  DayViewQuery,
  LessonRepository,
  AvailabilityRepository,
  AvailabilityUseCase,
  WindowsPolicy,
  OpenSlotsQuery,
  CreateLessonUseCase,
  LessonsQuery,
  PersonScheduleQuery,
  LessonSlotsQuery,
  GroupMembershipHandler,
  LessonLifecycleJob,
  LessonReportUseCase,
  SeriesRepository,
  SeriesInstancesService,
  SeriesMaterializer,
  SeriesUseCase,
  CancellationRepository,
  CancelLessonUseCase,
  CancelTemplatesQuery,
  BulkCancelUseCase,
  BookingRequestRepository,
  RescheduleLessonUseCase,
  RescheduleRequestUseCase,
  WeeklyLimitPolicy,
  BookSlotUseCase,
  AutoCancelHandler,
];

@Module({
  imports: [IdentityModule, AuditModule, OutboxModule, AccessModule, PeopleModule],
  providers: PROVIDERS,
  exports: PROVIDERS,
})
export class ScheduleModule {}
