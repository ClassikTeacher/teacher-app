import { createHash } from 'node:crypto';
import type { LessonView } from '@modules/schedule/lessons/lessons.query.js';
import type { LessonFormat, LessonStatus } from '@modules/schedule/schema.js';
import type { GoogleEventInput } from './google-api.js';

/** Statuses mirrored to Google (5.14.1 «ведёт в нём его занятия, включая переносы и отмены»): cancelled ones go. */
export const EXPORTED_STATUSES: readonly LessonStatus[] = ['scheduled', 'awaiting_report', 'completed'];
export const EXPORT_PAST_DAYS = 7;
export const EXPORT_AHEAD_DAYS = 90;
export const APP_MARKER = 'tutor-platform';

const FORMAT_LABEL: Record<LessonFormat, string> = {
  online: 'Онлайн',
  in_person: 'Очно',
  at_student: 'У ученика',
};

/** The Google event of a lesson as the teacher sees it: subject, who, format and place; no student contacts. */
export function eventOf(view: LessonView): GoogleEventInput {
  const { lesson } = view;
  const who = view.group ? view.group.name : view.participants.map((p) => p.displayName).join(', ');
  const lines: string[] = [];
  if (lesson.format) lines.push(FORMAT_LABEL[lesson.format]);
  if (lesson.plannedTopic) lines.push(`Тема: ${lesson.plannedTopic}`);
  if (lesson.format === 'online' && lesson.meetingUrl) lines.push(lesson.meetingUrl);
  return {
    summary: `${view.subject?.name ?? 'Занятие'} — ${who || 'без участников'}`,
    description: lines.length > 0 ? lines.join('\n') : null,
    location: lesson.format === 'online' ? null : (lesson.location ?? null),
    start: lesson.startsAt,
    end: lesson.endsAt,
    extendedPrivate: { app: APP_MARKER, lessonId: lesson.id },
  };
}

/** What was written last time; a lesson whose signature is unchanged is skipped (idempotent export). */
export function signatureOf(event: GoogleEventInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        event.summary,
        event.description,
        event.location,
        event.start.toISOString(),
        event.end.toISOString(),
      ]),
    )
    .digest('hex')
    .slice(0, 32);
}

/**
 * The Google event id of a lesson in a connection: sha256 hex is valid base32hex (0-9, a-v), so a sync that
 * crashed between the insert and the mapping re-creates nothing — the next insert hits the same id.
 */
export function eventIdFor(connectionId: string, lessonId: string): string {
  return createHash('sha256').update(`${connectionId}:${lessonId}`).digest('hex');
}

export interface ExportMapping {
  lessonId: string;
  googleEventId: string;
  signature: string;
  deleted: boolean;
}

export type ExportOp =
  | { op: 'insert'; lessonId: string; googleEventId: string; event: GoogleEventInput; signature: string }
  | { op: 'update'; lessonId: string; googleEventId: string; event: GoogleEventInput; signature: string }
  | { op: 'delete'; lessonId: string; googleEventId: string };

/**
 * Diff of the lessons that should be in Google against the mappings: live lessons of the window without a
 * mapping are inserted, changed ones updated; a mapped lesson outside the window is deleted only when it is
 * gone for good (`isGone`: cancelled, not held, missing) — completed history stays in the teacher's calendar.
 * Pure, so the sync service only executes.
 */
export function planExport(
  connectionId: string,
  live: readonly LessonView[],
  mappings: readonly ExportMapping[],
  isGone: (lessonId: string) => boolean,
): ExportOp[] {
  const byLesson = new Map(mappings.map((m) => [m.lessonId, m]));
  const ops: ExportOp[] = [];
  const seen = new Set<string>();
  for (const view of live) {
    seen.add(view.lesson.id);
    const event = eventOf(view);
    const signature = signatureOf(event);
    const mapping = byLesson.get(view.lesson.id);
    if (!mapping || mapping.deleted)
      ops.push({
        op: 'insert',
        lessonId: view.lesson.id,
        googleEventId: eventIdFor(connectionId, view.lesson.id),
        event,
        signature,
      });
    else if (mapping.signature !== signature)
      ops.push({
        op: 'update',
        lessonId: view.lesson.id,
        googleEventId: mapping.googleEventId,
        event,
        signature,
      });
  }
  for (const m of mappings) {
    if (!m.deleted && !seen.has(m.lessonId) && isGone(m.lessonId))
      ops.push({ op: 'delete', lessonId: m.lessonId, googleEventId: m.googleEventId });
  }
  return ops;
}
