import { Injectable } from '@nestjs/common';
import { type LessonView, LessonsQuery } from './lessons/lessons.query.js';
import { PersonalBlockRepository } from './occupancy/personal-block.repository.js';
import type { Interval, PersonalBlockRow } from './schema.js';

export type DayItem =
  { kind: 'block'; at: Date; block: PersonalBlockRow } | { kind: 'lesson'; at: Date; view: LessonView };

/** Everything a teacher sees in «Сегодня / Завтра / Неделя» (5.5.7): lessons (not cancelled) and personal blocks. */
@Injectable()
export class DayViewQuery {
  constructor(
    private readonly blocks: PersonalBlockRepository,
    private readonly lessons: LessonsQuery,
  ) {}

  async items(teacherId: string, range: Interval): Promise<DayItem[]> {
    const [blocks, lessons] = await Promise.all([
      this.blocks.listInRange(teacherId, range),
      this.lessons.teacherLessons(teacherId, range, [
        'scheduled',
        'awaiting_report',
        'completed',
        'not_held',
      ]),
    ]);
    return [
      ...blocks.map((block): DayItem => ({ kind: 'block', at: block.startsAt, block })),
      ...lessons.map((view): DayItem => ({ kind: 'lesson', at: view.lesson.startsAt, view })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());
  }
}
