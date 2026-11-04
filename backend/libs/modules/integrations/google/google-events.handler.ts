import { Injectable, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { Clock } from '@shared/time/clock.js';
import { type DeliveredEvent, DomainEventBus } from '@modules/outbox/event-bus.js';
import { ExternalBusyRepository } from '@modules/schedule/occupancy/external-busy.repository.js';
import { GoogleCalendarRepository } from './google-calendar.repository.js';

const withTeacher = z.object({ teacherId: z.string().uuid() });
const featureChanged = z.object({ teacherId: z.string().uuid(), feature: z.string(), enabled: z.boolean() });

/** Every change of a lesson schedule marks the teacher's connection for an export on the next tick (≤ 1 min). */
const LESSON_EVENTS = [
  'lesson.created',
  'lesson.rescheduled',
  'lesson.cancelled',
  'lesson.completed',
  'lesson.not_held',
  'lesson.participants_changed',
  'series.materialized',
] as const;

/**
 * 5.14.1 «включая переносы и отмены»: lesson events request an export; the feature switch (5.3.3) pauses the
 * integration — the imported busy time is dropped at once so students are not blocked by stale intervals,
 * and switching it back on requests a fresh sync. Idempotent: the handlers only set timestamps.
 */
@Injectable()
export class GoogleEventsHandler implements OnModuleInit {
  constructor(
    private readonly bus: DomainEventBus,
    private readonly repo: GoogleCalendarRepository,
    private readonly externalBusy: ExternalBusyRepository,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    for (const type of LESSON_EVENTS) this.bus.on(type, (e) => this.lessonChanged(e));
    this.bus.on('feature.changed', (e) => this.featureChanged(e));
  }

  private async lessonChanged(event: DeliveredEvent): Promise<void> {
    const parsed = withTeacher.safeParse(event.payload);
    if (!parsed.success) return;
    await this.repo.requestExport(parsed.data.teacherId, this.clock.now());
  }

  private async featureChanged(event: DeliveredEvent): Promise<void> {
    const parsed = featureChanged.safeParse(event.payload);
    if (!parsed.success || parsed.data.feature !== 'calendar.google') return;
    const now = this.clock.now();
    if (!parsed.data.enabled) {
      await this.externalBusy.clear(parsed.data.teacherId, 'google');
      return;
    }
    const row = await this.repo.findLive(parsed.data.teacherId);
    if (row && row.status === 'active')
      await this.repo.update(row.id, { lastImportAt: null, exportRequestedAt: now });
  }
}
