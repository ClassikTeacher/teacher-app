import { Injectable } from '@nestjs/common';
import { PG_EXCLUSION_VIOLATION, pgErrorCode } from '@shared/db/drizzle.js';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import type { Interval, OccupancyRow } from '../schema.js';
import { withBuffers } from './intervals.js';
import { type NewOccupancy, OccupancyRepository } from './occupancy.repository.js';

export interface TeacherSeat {
  accountId: string;
  bufferBeforeMin: number;
  bufferAfterMin: number;
}

export interface ReserveInput {
  source: { kind: 'lesson'; lessonId: string } | { kind: 'block'; blockId: string };
  during: Interval;
  /** The teacher's row is widened by the buffers and records them (CAL-04). */
  teacher: TeacherSeat;
  /** Students get plain rows (buffers are the teacher's business only). */
  studentIds: readonly string[];
}

/** Who is busy, without details of their other engagement (CAL-06, CAL-07). */
export type ConflictParty = { who: 'teacher' } | { who: 'student'; studentId: string };

/** Students once each and never the teacher (a teacher cannot be their own student in one lesson). */
function uniqueStudents(studentIds: readonly string[], teacherId: string): string[] {
  return [...new Set(studentIds)].filter((id) => id !== teacherId);
}

export function conflictError(party: ConflictParty | null): AppError {
  return new AppError('LESSON_CONFLICT', 'Time is already taken', party ?? { who: 'unknown' });
}

/**
 * Writes occupancy for a lesson or a block inside the caller's transaction (7.5): an ordinary overlap check
 * first, so the user gets a message naming the busy party; the EXCLUDE constraint (23P01) stays the guard
 * against races and is reported as the same LESSON_CONFLICT without a party.
 */
@Injectable()
export class OccupancyService {
  constructor(
    private readonly txm: TransactionManager,
    private readonly repo: OccupancyRepository,
  ) {}

  /** Returns the busy party for a would-be reservation, or null when everyone is free. */
  async findConflict(input: Omit<ReserveInput, 'source'>): Promise<ConflictParty | null> {
    const teacherSpan = withBuffers(
      input.during,
      input.teacher.bufferBeforeMin,
      input.teacher.bufferAfterMin,
    );
    const teacherRows = await this.repo.findActiveOverlaps([input.teacher.accountId], teacherSpan);
    if (teacherRows.length > 0) return { who: 'teacher' };
    const studentRows = await this.repo.findActiveOverlaps(
      uniqueStudents(input.studentIds, input.teacher.accountId),
      input.during,
    );
    const first = studentRows.sort((a, b) => a.during.start.getTime() - b.during.start.getTime())[0];
    return first ? { who: 'student', studentId: first.accountId } : null;
  }

  async reserve(input: ReserveInput): Promise<OccupancyRow[]> {
    const students = uniqueStudents(input.studentIds, input.teacher.accountId);
    const conflict = await this.findConflict({ ...input, studentIds: students });
    if (conflict) throw conflictError(conflict);
    const ref =
      input.source.kind === 'lesson'
        ? { lessonId: input.source.lessonId }
        : { blockId: input.source.blockId };
    const rows: NewOccupancy[] = [
      {
        ...ref,
        kind: input.source.kind,
        accountId: input.teacher.accountId,
        during: withBuffers(input.during, input.teacher.bufferBeforeMin, input.teacher.bufferAfterMin),
        bufferBeforeMin: input.teacher.bufferBeforeMin,
        bufferAfterMin: input.teacher.bufferAfterMin,
      },
      ...students.map((accountId) => ({ ...ref, kind: input.source.kind, accountId, during: input.during })),
      // deterministic insert order: two concurrent group lessons sharing students cannot deadlock (40P01)
    ].sort((a, b) => a.accountId.localeCompare(b.accountId));
    try {
      return await this.txm.runSavepoint(() => this.repo.insertMany(rows));
    } catch (error) {
      if (pgErrorCode(error) === PG_EXCLUSION_VIOLATION) throw conflictError(null); // lost the race (CAL-10)
      throw error;
    }
  }

  /** Adds one student to an existing lesson's occupancy (group membership applied to future lessons). */
  async reserveStudent(lessonId: string, studentId: string, during: Interval): Promise<OccupancyRow> {
    const busy = await this.repo.findActiveOverlaps([studentId], during);
    if (busy.length > 0) throw conflictError({ who: 'student', studentId });
    try {
      const rows = await this.txm.runSavepoint(() =>
        this.repo.insertMany([{ kind: 'lesson', lessonId, accountId: studentId, during }]),
      );
      return rows[0]!;
    } catch (error) {
      if (pgErrorCode(error) === PG_EXCLUSION_VIOLATION) throw conflictError({ who: 'student', studentId });
      throw error;
    }
  }

  releaseLesson(lessonId: string, accountId?: string): Promise<number> {
    return this.repo.deactivateByLesson(lessonId, accountId);
  }

  releaseBlock(blockId: string): Promise<number> {
    return this.repo.deactivateByBlock(blockId);
  }
}
