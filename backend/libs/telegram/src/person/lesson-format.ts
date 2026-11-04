import { DateTime } from 'luxon';
import type { PersonLessonView } from '@modules/schedule/lessons/person-schedule.query.js';
import type { LessonStatus } from '@modules/schedule/schema.js';
import type { BotContext } from '../core/context.js';
import { clip, fullName } from '../core/format.js';
import { escapeHtml } from '../core/ui.js';

const STATUS_MARK: Record<LessonStatus, string> = {
  scheduled: '🕓',
  awaiting_report: '📝',
  completed: '✅',
  not_held: '🚫',
  cancelled: '❌',
};

export function personZone(ctx: BotContext): string {
  return ctx.actor?.account.timezone ?? 'UTC';
}

function fmt(at: Date, zone: string, format: string, locale: string): string {
  return DateTime.fromJSDate(at, { zone }).setLocale(locale).toFormat(format);
}

/** One line of the person's schedule list (HTML), in the recipient's zone (CAL-05). */
export function personLessonLine(ctx: BotContext, v: PersonLessonView, zone: string): string {
  const locale = ctx.actor?.account.locale ?? 'ru';
  return ctx.t('person-lesson-line', {
    mark: STATUS_MARK[v.lesson.status],
    day: fmt(v.lesson.startsAt, zone, 'ccc dd.MM', locale),
    time: `${fmt(v.lesson.startsAt, zone, 'HH:mm', locale)}–${fmt(v.lesson.endsAt, zone, 'HH:mm', locale)}`,
    teacher: escapeHtml(fullName(v.teacher)),
    subject: v.subject ? ` · ${escapeHtml(v.subject.name)}` : '',
  });
}

/** Button label (plain text). */
export function personLessonButton(ctx: BotContext, v: PersonLessonView, zone: string): string {
  const locale = ctx.actor?.account.locale ?? 'ru';
  return clip(
    `${STATUS_MARK[v.lesson.status]} ${fmt(v.lesson.startsAt, zone, 'ccc dd.MM HH:mm', locale)} ${fullName(v.teacher)}`,
    40,
  );
}

/** The lesson card for a student or a parent (5.6.1 without teacher notes), HTML. */
export function personLessonCard(ctx: BotContext, v: PersonLessonView, zone: string): string {
  const locale = ctx.actor?.account.locale ?? 'ru';
  const { lesson } = v;
  const details: string[] = [];
  if (lesson.topic) details.push(ctx.t('person-lesson-topic', { topic: escapeHtml(lesson.topic) }));
  if (lesson.format) {
    const live = lesson.status === 'scheduled' || lesson.status === 'awaiting_report';
    const place = lesson.format === 'online' ? (live ? lesson.meetingUrl : null) : lesson.location;
    details.push(
      ctx.t(`lesson-format-${lesson.format.replace(/_/g, '-')}`) + (place ? `: ${escapeHtml(place)}` : ''),
    );
  }
  if (lesson.sharedComment && lesson.status === 'completed')
    details.push(ctx.t('person-lesson-comment', { comment: escapeHtml(lesson.sharedComment) }));
  return ctx.t('person-lesson-card', {
    title: lesson.seqNo ? ctx.t('lesson-title-numbered', { n: lesson.seqNo }) : ctx.t('lesson-title'),
    status: ctx.t(`lesson-status-${lesson.status.replace(/_/g, '-')}`),
    day: fmt(lesson.startsAt, zone, 'cccc dd.MM', locale),
    time: `${fmt(lesson.startsAt, zone, 'HH:mm', locale)}–${fmt(lesson.endsAt, zone, 'HH:mm', locale)}`,
    duration: Math.round((lesson.endsAt.getTime() - lesson.startsAt.getTime()) / 60_000),
    teacher: escapeHtml(fullName(v.teacher)),
    subject: v.subject ? escapeHtml(v.subject.name) : '—',
    details: details.join('\n'),
  });
}

/** "вторник 20.10 18:00–19:00" in the person's zone — the lesson named in dialogs and confirmations. */
export function personLessonWhen(ctx: BotContext, v: PersonLessonView, zone: string): string {
  const locale = ctx.actor?.account.locale ?? 'ru';
  return `${fmt(v.lesson.startsAt, zone, 'cccc dd.MM', locale)} ${fmt(v.lesson.startsAt, zone, 'HH:mm', locale)}–${fmt(v.lesson.endsAt, zone, 'HH:mm', locale)}`;
}
