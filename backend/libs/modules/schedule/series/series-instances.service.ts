import { Injectable } from '@nestjs/common';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { type CancelContext, CancelLessonUseCase } from '../cancellations/cancel-lesson.use-case.js';
import { CancellationRepository } from '../cancellations/cancellation.repository.js';
import { LessonRepository } from '../lessons/lesson.repository.js';
import { SeriesRepository } from './series.repository.js';

export type InstanceCancelReason = 'series_paused' | 'series_ended' | 'series_changed';

/**
 * Cancels the scheduled instances of a series in a date range (pause, end, split; 5.5.6) through the single
 * cancellation path: one system cancellation record (CNL-08) with one item per instance, occupancy freed,
 * `lesson.cancelled` per instance (reminders) and one `cancellation.bulk` summary per batch (NTF-07, 5.7.6).
 */
@Injectable()
export class SeriesInstancesService {
  constructor(
    private readonly series: SeriesRepository,
    private readonly lessons: LessonRepository,
    private readonly single: CancelLessonUseCase,
    private readonly cancellations: CancellationRepository,
    private readonly outbox: OutboxService,
  ) {}

  async cancel(
    seriesId: string,
    from: Date,
    to: Date | undefined,
    reason: InstanceCancelReason,
    now: Date,
    byAccountId: string | null = null,
  ): Promise<string[]> {
    const rows = await this.series.lockScheduledInstances(seriesId, from, to);
    if (rows.length === 0) return [];
    const cancellation = await this.cancellations.insert({
      initiatorId: byAccountId,
      initiatorRole: 'SYSTEM',
      kind: 'system',
      reason, // a code: the notification handler renders the text by locale (M-3)
      source: reason,
      createdAt: now,
    });
    const ctx: CancelContext = { cancellation, role: 'SYSTEM', actorId: byAccountId, source: 'system' };
    const items: Array<{ lessonId: string; teacherId: string; startsAt: string; studentIds: string[] }> = [];
    for (const lesson of rows) {
      const studentIds = (await this.lessons.listParticipants(lesson.id)).map((p) => p.studentId);
      await this.single.cancelLocked(lesson, ctx, false, now);
      items.push({
        lessonId: lesson.id,
        teacherId: lesson.teacherId,
        startsAt: lesson.startsAt.toISOString(),
        studentIds,
      });
    }
    await this.outbox.publish({
      type: 'cancellation.bulk',
      aggregateType: 'cancellation',
      aggregateId: cancellation.id,
      payload: {
        cancellationId: cancellation.id,
        byAccountId,
        byRole: 'SYSTEM',
        source: reason,
        onBehalfOfStudentId: null,
        message: cancellation.reason,
        lessons: items.map((i) => ({ ...i, action: 'cancelled', isLate: false })),
      },
    });
    return rows.map((r) => r.id);
  }
}
