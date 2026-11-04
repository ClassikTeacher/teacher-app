import { Injectable, Logger } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { Clock } from '@shared/time/clock.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { LessonRepository } from './lesson.repository.js';

const BATCH = 200;

/**
 * LES-01 / UC-38: a scheduled lesson whose end has passed becomes `awaiting_report`; the transition is written to
 * the history and published (`lesson.awaiting_report`) so the teacher gets «Как прошло занятие?» (LES-06).
 * Runs from the worker every minute; rows are locked with SKIP LOCKED so parallel passes never collide.
 */
@Injectable()
export class LessonLifecycleJob {
  private readonly logger = new Logger(LessonLifecycleJob.name);

  constructor(
    private readonly txm: TransactionManager,
    private readonly lessons: LessonRepository,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  async run(): Promise<number> {
    let total = 0;
    for (;;) {
      const now = this.clock.now();
      const count = await this.txm.run(async () => {
        const over = await this.lessons.lockScheduledEndedBefore(now, BATCH);
        for (const lesson of over) {
          await this.lessons.update(lesson.id, { status: 'awaiting_report' });
          await this.lessons.addEvent({
            lessonId: lesson.id,
            type: 'awaiting_report',
            actorId: null,
            payload: { endsAt: lesson.endsAt.toISOString() },
            at: now,
          });
          const participants = await this.lessons.listParticipants(lesson.id);
          await this.outbox.publish({
            type: 'lesson.awaiting_report',
            aggregateType: 'lesson',
            aggregateId: lesson.id,
            payload: {
              lessonId: lesson.id,
              teacherId: lesson.teacherId,
              groupId: lesson.groupId,
              studentIds: participants.map((p) => p.studentId),
              endsAt: lesson.endsAt.toISOString(),
            },
          });
        }
        return over.length;
      });
      total += count;
      if (count < BATCH) break;
    }
    if (total > 0) this.logger.debug({ count: total }, 'lessons moved to awaiting_report');
    return total;
  }
}
