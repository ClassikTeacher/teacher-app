import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import type { Actor } from '@modules/access/actor.js';
import { type DeliveredEvent, DomainEventBus } from '@modules/outbox/event-bus.js';
import { LessonRepository } from '@modules/schedule/lessons/lesson.repository.js';
import { GrantsUseCase, type LessonGrantTarget } from './grants.use-case.js';
import { MaterialRepository } from './material.repository.js';
import type { LessonMaterialRow, Release } from './schema.js';

const uuid = z.string().uuid();
const lessonCompleted = z.object({ lessonId: uuid, teacherId: uuid, studentIds: z.array(uuid) });
const participantsChanged = z.object({ lessonId: uuid, added: z.array(uuid), removed: z.array(uuid) });

function parse<T>(schema: z.ZodType<T>, event: DeliveredEvent): T {
  const result = schema.safeParse(event.payload);
  if (!result.success)
    throw new UnrecoverableError(`malformed ${event.type} payload: ${result.error.message}`);
  return result.data;
}

const targetOf = (row: LessonMaterialRow): LessonGrantTarget =>
  row.materialId ? { materialId: row.materialId } : { collectionId: row.collectionId! };

/**
 * 5.9.3 «Через занятие»: materials marked `after` reach the participants when the report is filed
 * (`lesson.completed`); a student who joins a lesson later receives its `before` materials (and the `after`
 * ones if the lesson is already reported). Grants are idempotent per lesson and student.
 */
@Injectable()
export class LessonContentHandler implements OnModuleInit {
  constructor(
    private readonly bus: DomainEventBus,
    private readonly materials: MaterialRepository,
    private readonly lessons: LessonRepository,
    private readonly grants: GrantsUseCase,
  ) {}

  onModuleInit(): void {
    this.bus.on('lesson.completed', (e) => this.completed(e));
    this.bus.on('lesson.participants_changed', (e) => this.participantsChanged(e));
  }

  private async completed(event: DeliveredEvent): Promise<void> {
    const p = parse(lessonCompleted, event);
    await this.handOut(p.lessonId, p.studentIds, ['after']);
  }

  private async participantsChanged(event: DeliveredEvent): Promise<void> {
    const p = parse(participantsChanged, event);
    for (const studentId of p.removed) await this.grants.revokeLessonGrants(p.lessonId, studentId);
    if (p.added.length === 0) return;
    const lesson = await this.lessons.findById(p.lessonId);
    if (!lesson) return;
    const reported = lesson.status === 'completed' || lesson.status === 'not_held';
    await this.handOut(p.lessonId, p.added, reported ? ['before', 'after'] : ['before']);
  }

  private async handOut(
    lessonId: string,
    studentIds: readonly string[],
    releases: readonly Release[],
  ): Promise<void> {
    const attached = (await this.materials.listLessonMaterials(lessonId)).filter((m) =>
      releases.includes(m.release),
    );
    if (attached.length === 0 || studentIds.length === 0) return;
    const lesson = await this.lessons.findById(lessonId);
    if (!lesson) return;
    const teacher: Actor = {
      accountId: lesson.teacherId,
      roles: ['TEACHER'],
      status: 'active',
      source: 'system',
    };
    await this.grants.grantFromLesson(teacher, lessonId, studentIds, attached.map(targetOf));
  }
}
