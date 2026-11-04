import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { AppError } from '@shared/errors/app-error.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import type { TeacherStudentRow } from '@modules/people/schema.js';
import { LessonRepository } from '../lessons/lesson.repository.js';

/**
 * PPL-06: the per-student weekly limit of the link applies to self-booking in both modes (5.5.5). The week
 * is Monday–Sunday in the teacher's zone; cancelled lessons do not count, everything else of the pair does.
 */
@Injectable()
export class WeeklyLimitPolicy {
  constructor(
    private readonly lessons: LessonRepository,
    private readonly accounts: AccountRepository,
  ) {}

  /** Throws WEEKLY_LIMIT_EXCEEDED when one more lesson at `startsAt` would exceed the link's limit. */
  async assertRoom(link: TeacherStudentRow, startsAt: Date): Promise<void> {
    const limit = link.maxLessonsPerWeek;
    if (limit === null || !link.studentId) return;
    const zone = (await this.accounts.findById(link.teacherId))?.timezone ?? 'UTC';
    const week = DateTime.fromJSDate(startsAt, { zone }).startOf('week');
    const range = { start: week.toJSDate(), end: week.plus({ weeks: 1 }).toJSDate() };
    const rows = await this.lessons.listByStudent(link.studentId, range);
    const count = rows.filter((l) => l.teacherId === link.teacherId && l.status !== 'cancelled').length;
    if (count >= limit)
      throw new AppError('WEEKLY_LIMIT_EXCEEDED', 'Weekly limit of lessons reached', { limit, count });
  }
}
