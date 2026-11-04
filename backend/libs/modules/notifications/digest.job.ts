import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { Clock } from '@shared/time/clock.js';
import { formatInZone } from '@shared/time/timezone.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import type { AccountRow } from '@modules/identity/schema.js';
import { LessonsQuery } from '@modules/schedule/lessons/lessons.query.js';
import { GradeEntryRepository } from '@modules/gradebook/grade-entry.repository.js';
import { SubmissionRepository } from '@modules/homework/submission.repository.js';
import { BookingRequestRepository } from '@modules/schedule/requests/booking-request.repository.js';
import { timeToMinutes } from './delivery-policy.js';
import { NotificationPrefsRepository } from './notification-prefs.repository.js';
import { NotificationRepository } from './notification.repository.js';
import { NotificationService } from './notification.service.js';

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const BATCH = 200;
/** The digest is sent within this many minutes after the chosen time, never later (5.5.7). */
export const CATCH_UP_MIN = 3 * 60;

/**
 * 5.5.7 «Утренняя сводка»: once a day at the teacher's chosen local time — today's lessons, lessons without a
 * report (LES-07 sweep), open requests; unchecked submissions join in M5. One row per teacher and day
 * (dedupe key `digest.daily:<teacher>:<date>`), so a late or repeated pass cannot send it twice.
 */
@Injectable()
export class DailyDigestJob {
  private readonly logger = new Logger(DailyDigestJob.name);

  constructor(
    private readonly txm: TransactionManager,
    private readonly accounts: AccountRepository,
    private readonly prefs: NotificationPrefsRepository,
    private readonly lessons: LessonsQuery,
    private readonly requests: BookingRequestRepository,
    private readonly submissions: SubmissionRepository,
    private readonly grades: GradeEntryRepository,
    private readonly notifications: NotificationService,
    private readonly repo: NotificationRepository,
    private readonly clock: Clock,
  ) {}

  async run(): Promise<number> {
    const now = this.clock.now();
    let sent = 0;
    for (let page = 1; ; page += 1) {
      const { items } = await this.accounts.listByRole('TEACHER', { page, limit: BATCH });
      for (const teacher of items) sent += (await this.maybeSend(teacher, now)) ? 1 : 0;
      if (items.length < BATCH) break;
    }
    if (sent > 0) this.logger.debug({ sent }, 'daily digests scheduled');
    return sent;
  }

  /** One teacher: inside the window [digestTime, digestTime + CATCH_UP) and not yet sent today; errors are logged. */
  private async maybeSend(teacher: AccountRow, now: Date): Promise<boolean> {
    if (teacher.status !== 'active') return false;
    try {
      const profile = await this.prefs.profile(teacher.id);
      if (!profile.digestEnabled) return false;
      const local = DateTime.fromJSDate(now, { zone: teacher.timezone });
      const minutes = local.hour * 60 + local.minute;
      const at = timeToMinutes(profile.digestTime);
      // a worker that was down all day must not send a «morning» digest in the evening
      if (minutes < at || minutes >= at + CATCH_UP_MIN) return false;
      const date = local.toISODate()!;
      if (await this.repo.existsByKey(`digest.daily:${teacher.id}:${date}`)) return false;
      return await this.txm.run(() => this.sendFor(teacher.id, teacher.timezone, local, date));
    } catch (error) {
      this.logger.error({ err: error, teacherId: teacher.id }, 'daily digest failed');
      return false;
    }
  }

  private async sendFor(teacherId: string, zone: string, local: DateTime, date: string): Promise<boolean> {
    const day = {
      start: local.startOf('day').toJSDate(),
      end: local.startOf('day').plus({ days: 1 }).toJSDate(),
    };
    const [today, awaiting, pending, unchecked, grades] = await Promise.all([
      this.lessons.teacherLessons(teacherId, day, ['scheduled', 'awaiting_report', 'completed']),
      this.lessons.awaitingReport(teacherId),
      this.requests.listPendingByTeacher(teacherId),
      this.submissions.countUnreviewed(teacherId), // 5.10.5: unchecked work joins the morning digest
      this.grades.countPending(teacherId), // 5.11.2 💡 (M6-01): marks reported by students await the teacher
    ]);
    const who = (v: (typeof today)[number]): string =>
      v.group ? v.group.name : v.participants.map((p) => p.displayName).join(', ');
    const lines = today
      .map((v) => `${formatInZone(v.lesson.startsAt, zone, 'HH:mm')} ${esc(who(v))}`)
      .join(', ');
    const row = await this.notifications.schedule({
      type: 'digest.daily',
      recipientId: teacherId,
      payload: {
        date: formatInZone(day.start, zone, 'ccc dd.MM'),
        count: today.length,
        lessons: lines,
        awaiting: awaiting.length,
        requests: pending.length,
        unchecked,
        grades,
      },
      dedupeKey: `digest.daily:${teacherId}:${date}`,
      keepTime: true,
    });
    return row !== null;
  }
}
