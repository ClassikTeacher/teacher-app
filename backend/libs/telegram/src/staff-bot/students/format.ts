import { InlineKeyboard } from 'grammy';
import { formatInZone } from '@shared/time/timezone.js';
import type { IssuedInvitation } from '@modules/identity/invitation.service.js';
import {
  cardDisplayName,
  type PendingCardItem,
  type StudentCard,
} from '@modules/people/links/students.query.js';
import type { SubjectRow, TeacherStudentRow } from '@modules/people/schema.js';
import type { BotContext } from '../../core/context.js';
import { fullName } from '../../core/format.js';
import { escapeHtml, say } from '../../core/ui.js';
import { sectionCb } from '../section-module.js';

export const DATE_FORMAT = 'dd.MM.yyyy';

/** A calendar date in the acting person's timezone. */
export function formatDate(ctx: BotContext, value: Date): string {
  return formatInZone(value, ctx.actor?.account.timezone ?? 'UTC', DATE_FORMAT);
}

/** State of a card awaiting acceptance, derived from the link and its invitation (plain text). */
export function pendingState(ctx: BotContext, item: PendingCardItem, now: Date): string {
  if (item.link.status === 'declined') return ctx.t('pending-state-declined');
  const inv = item.invitation;
  if (!inv || inv.status === 'revoked') return ctx.t('pending-state-revoked');
  if (inv.status === 'expired' || inv.expiresAt.getTime() <= now.getTime())
    return ctx.t('pending-state-expired');
  return ctx.t('pending-state-waiting', { until: formatDate(ctx, inv.expiresAt) });
}

function statusLine(ctx: BotContext, card: StudentCard, now: Date): string[] {
  const { link } = card;
  if (link.status === 'active') {
    const since = link.startedAt ? formatDate(ctx, link.startedAt) : '—';
    return [`${ctx.t('card-status')}: ${ctx.t('link-status-active', { since })}`];
  }
  if (link.status === 'ended') {
    const on = link.endedAt ? formatDate(ctx, link.endedAt) : '—';
    const reason = ctx.t(`end-reason-${(link.endReason ?? 'system').replace(/_/g, '-')}`);
    return [
      `${ctx.t('card-status')}: ${ctx.t('link-status-ended', { on })}`,
      `${ctx.t('card-end-reason')}: ${reason}`,
    ];
  }
  return [`${ctx.t('card-status')}: ${pendingState(ctx, { link, invitation: card.invitation }, now)}`];
}

/** Student card body (5.4.1), HTML-escaped. */
export function studentCardText(ctx: BotContext, card: StudentCard, now: Date): string {
  const { link, student, profile, subjects } = card;
  const handle = student?.username ? ` · @${escapeHtml(student.username)}` : '';
  const realName = link.alias && student ? ` (${escapeHtml(fullName(student))})` : '';
  const grade = link.status === 'pending' ? link.inviteGrade : (profile?.grade ?? null);
  const limit = link.maxLessonsPerWeek === null ? ctx.t('limit-none') : String(link.maxLessonsPerWeek);
  const lines = [
    `<b>${escapeHtml(cardDisplayName(card))}</b>${realName}${handle}`,
    ...statusLine(ctx, card, now),
    `${ctx.t('card-grade')}: ${grade ? escapeHtml(grade) : '—'} · ${ctx.t('card-school')}: ${profile?.school ? escapeHtml(profile.school) : '—'}`,
    `${ctx.t('card-subjects')}: ${escapeHtml(subjects.map((s) => s.name).join(', ') || '—')}`,
    `${ctx.t('card-weekly-limit')}: ${limit}`,
  ];
  if (link.goals) lines.push(`${ctx.t('card-goals')}: ${escapeHtml(link.goals)}`);
  if (link.notes) lines.push(`${ctx.t('card-notes')}: ${escapeHtml(link.notes)}`);
  return lines.join('\n');
}

/**
 * The forwardable invitation card (UC-10 step 3): a separate message naming the teacher, so the student
 * understands it out of context (4.1). Buttons: open link, withdraw, back to the list.
 */
export async function sendInvitationCard(
  ctx: BotContext,
  link: TeacherStudentRow,
  issued: IssuedInvitation,
  subjects: SubjectRow[],
): Promise<void> {
  const teacher = ctx.actor ? fullName(ctx.actor.account) : '—';
  const forLine = link.inviteName ? ctx.t('invite-student-for', { name: escapeHtml(link.inviteName) }) : '';
  const limitLine =
    link.maxLessonsPerWeek === null
      ? ctx.t('invite-student-no-limit')
      : ctx.t('invite-student-limit-line', { limit: link.maxLessonsPerWeek });
  const kb = new InlineKeyboard()
    .url(ctx.t('btn-open-invite-link'), issued.link)
    .row()
    .text(ctx.t('btn-revoke-invite'), sectionCb('students', 'revoke', link.id))
    .text(ctx.t('btn-to-students'), sectionCb('students', 'list'));
  await say(
    ctx,
    ctx.t('invite-student-card', {
      teacher: escapeHtml(teacher),
      forLine,
      subjects: escapeHtml(subjects.map((s) => s.name).join(', ') || '—'),
      limitLine,
      expires: formatDate(ctx, issued.invitation.expiresAt),
      link: issued.link,
    }),
    kb,
  );
}
