import { InlineKeyboard } from 'grammy';
import type { AppError } from '@shared/errors/app-error.js';
import type { BotContext } from '../core/context.js';

const EXPLAINED = [
  'CANCEL_DISABLED',
  'CANCEL_CUTOFF',
  'LESSON_STARTED',
  'LINK_NOT_ACTIVE',
  'CONFLICT',
] as const;

/** UC-20 alternatives: why the bot cannot cancel, or null for errors that are not about the rules. */
export function explainCancelError(ctx: BotContext, error: AppError): string | null {
  if (!(EXPLAINED as readonly string[]).includes(error.code)) return null;
  const code = error.code.toLowerCase().replace(/_/g, '-');
  const hours = error.details?.['cutoffHours'];
  const text = ctx.t('cancel-not-possible', { code, hours: typeof hours === 'number' ? hours : 0 });
  const hint =
    error.code === 'CONFLICT' || error.code === 'LINK_NOT_ACTIVE'
      ? ''
      : ` ${ctx.t('cancel-write-teacher-hint')}`;
  return `${text}${hint}`;
}

/** «Написать учителю» (when the teacher has a username) and the way back. */
export function cancelErrorKeyboard(
  ctx: BotContext,
  teacherUsername: string | null,
  backCb: string,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (teacherUsername) kb.url(ctx.t('btn-write-teacher'), `https://t.me/${teacherUsername}`).row();
  return kb.text(ctx.t('btn-cancel-back'), backCb);
}
