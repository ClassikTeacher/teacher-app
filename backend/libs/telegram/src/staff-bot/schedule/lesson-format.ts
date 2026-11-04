import type { LessonView } from '@modules/schedule/lessons/lessons.query.js';
import type { LessonStatus } from '@modules/schedule/schema.js';
import type { BotContext } from '../../core/context.js';
import { clip } from '../../core/format.js';
import { escapeHtml } from '../../core/ui.js';
import { fmtDayOf, fmtTime } from './time-input.js';

const STATUS_MARK: Record<LessonStatus, string> = {
  scheduled: '🕓',
  awaiting_report: '📝',
  completed: '✅',
  not_held: '🚫',
  cancelled: '❌',
};

/** "Петя" / "🔢 10А математика" / "Петя, Маша" — plain text. */
export function lessonWho(ctx: BotContext, view: LessonView): string {
  if (view.group) return `${view.group.emoji ? `${view.group.emoji} ` : ''}${view.group.name}`;
  const names = view.participants.map((p) => p.displayName);
  return names.join(', ') || ctx.t('lesson-no-participants');
}

export function lessonTimeRange(view: LessonView, zone: string): string {
  return `${fmtTime(view.lesson.startsAt, zone)}–${fmtTime(view.lesson.endsAt, zone)}`;
}

/** One line of a day list (HTML). */
export function lessonLine(ctx: BotContext, view: LessonView, zone: string): string {
  const subject = view.subject ? ` · ${escapeHtml(view.subject.name)}` : '';
  const outside =
    view.lesson.outsideWindows && view.lesson.status === 'scheduled'
      ? ` ${ctx.t('lesson-outside-mark')}`
      : '';
  return `${STATUS_MARK[view.lesson.status]} ${lessonTimeRange(view, zone)} ${escapeHtml(lessonWho(ctx, view))}${subject}${outside}`;
}

/** Button label of a lesson in a day list (plain text). */
export function lessonButtonLabel(ctx: BotContext, view: LessonView, zone: string): string {
  return clip(
    `${STATUS_MARK[view.lesson.status]} ${fmtTime(view.lesson.startsAt, zone)} ${lessonWho(ctx, view)}`,
    40,
  );
}

/** Lesson card body (5.6.1), HTML. */
export function lessonCardText(ctx: BotContext, view: LessonView, zone: string): string {
  const { lesson } = view;
  const title = lesson.seqNo ? ctx.t('lesson-title-numbered', { n: lesson.seqNo }) : ctx.t('lesson-title');
  const lines = [
    `<b>${title}</b> · ${ctx.t(`lesson-status-${lesson.status.replace(/_/g, '-')}`)}`,
    `${fmtDayOf(lesson.startsAt, zone)} ${lessonTimeRange(view, zone)}`,
    `${ctx.t('lesson-card-who')}: ${escapeHtml(lessonWho(ctx, view))}`,
    `${ctx.t('lesson-card-subject')}: ${view.subject ? escapeHtml(view.subject.name) : '—'}`,
  ];
  if (view.group && view.participants.length > 0)
    lines.push(
      `${ctx.t('lesson-card-participants')}: ${escapeHtml(view.participants.map((p) => p.displayName).join(', '))}`,
    );
  if (lesson.plannedTopic)
    lines.push(`${ctx.t('lesson-card-planned-topic')}: ${escapeHtml(lesson.plannedTopic)}`);
  if (lesson.topic) lines.push(`${ctx.t('lesson-card-topic')}: ${escapeHtml(lesson.topic)}`);
  if (lesson.format) {
    const place = lesson.format === 'online' ? lesson.meetingUrl : lesson.location;
    lines.push(
      `${ctx.t(`lesson-format-${lesson.format.replace(/_/g, '-')}`)}${place ? `: ${escapeHtml(place)}` : ''}`,
    );
  }
  if (lesson.outsideWindows && lesson.status === 'scheduled') lines.push(ctx.t('lesson-outside-note'));
  if (lesson.notHeldReason)
    lines.push(`${ctx.t('lesson-card-not-held-reason')}: ${escapeHtml(lesson.notHeldReason)}`);
  if (lesson.sharedComment)
    lines.push(`${ctx.t('lesson-card-comment')}: ${escapeHtml(lesson.sharedComment)}`);
  if (lesson.teacherNotes) lines.push(`${ctx.t('lesson-card-notes')}: ${escapeHtml(lesson.teacherNotes)}`);
  return lines.join('\n');
}
