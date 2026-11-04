import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import type { Actor } from '@modules/access/actor.js';
import { FamilyQuery } from '@modules/people/family/family.query.js';
import { InviteParentUseCase } from '@modules/people/family/invite-parent.use-case.js';
import { RevokeFamilyLinkUseCase } from '@modules/people/family/revoke-family-link.use-case.js';
import { cardDisplayName, type StudentCard } from '@modules/people/links/students.query.js';
import type { BotContext } from '../../core/context.js';
import { clip, fullName } from '../../core/format.js';
import { escapeHtml, renderMenu, say } from '../../core/ui.js';
import { parentLine } from '../../person/format.js';
import { sectionCb } from '../section-module.js';
import { formatDate } from './format.js';

/** Session key: which student card the "Родители" screen belongs to (callback payloads hold one id only). */
export const PARENTS_CARD_KEY = 'parentsCardLinkId';

/**
 * "Родители" screen of the student card (UC-11, 5.4.3): active parents (revocable by the inviting teacher,
 * with confirmation), outstanding parent links (revocable), and "Пригласить родителя" which yields a
 * forwardable ParentBot card. Revocations are idempotent: a double tap reports "already revoked".
 */
@Injectable()
export class ParentsScreen {
  constructor(
    private readonly family: FamilyQuery,
    private readonly invite: InviteParentUseCase,
    private readonly revokeLink: RevokeFamilyLinkUseCase,
    private readonly clock: Clock,
  ) {}

  async render(ctx: BotContext, actor: Actor, card: StudentCard): Promise<void> {
    const studentId = card.link.studentId;
    if (!studentId) return; // pending cards have no student yet; the card keyboard does not offer this screen
    ctx.session.scratch = { ...(ctx.session.scratch ?? {}), [PARENTS_CARD_KEY]: card.link.id };
    const [parents, pending] = await Promise.all([
      this.family.parentsOf(studentId),
      this.invite.pendingFor(actor.accountId, studentId, this.clock.now()),
    ]);
    const kb = new InlineKeyboard();
    const lines: string[] = [];
    for (const { link, parent } of parents) {
      const mine = link.invitedBy === actor.accountId;
      lines.push(`• ${parentLine(parent)}${mine ? '' : ` — ${ctx.t('parent-invited-elsewhere')}`}`);
      if (mine) {
        kb.text(
          ctx.t('btn-unlink-parent', { name: clip(fullName(parent), 24) }),
          sectionCb('students', 'prevoke', link.id),
        ).row();
      }
    }
    for (const inv of pending) {
      const until = formatDate(ctx, inv.expiresAt);
      lines.push(`• ${ctx.t('parent-link-pending', { until })}`);
      kb.text(ctx.t('btn-revoke-parent-link', { until }), sectionCb('students', 'pinvrevoke', inv.id)).row();
    }
    if (card.link.status === 'active') {
      kb.text(ctx.t('btn-invite-parent'), sectionCb('students', 'pinvite', card.link.id)).row();
    }
    kb.text(ctx.t('btn-back'), sectionCb('students', 'card', card.link.id));
    const body = lines.length > 0 ? lines.join('\n') : ctx.t('parents-empty');
    const title = ctx.t('parents-title', { student: escapeHtml(cardDisplayName(card)) });
    await renderMenu(ctx, `${title}\n\n${body}`, kb);
  }

  /** The card this screen was opened for (null when the session forgot it). */
  cardLinkId(ctx: BotContext): string | null {
    const id = ctx.session.scratch?.[PARENTS_CARD_KEY];
    return typeof id === 'string' ? id : null;
  }

  /** UC-11 step 2: a separate forwardable message with the ParentBot link. */
  async inviteParent(ctx: BotContext, actor: Actor, card: StudentCard): Promise<void> {
    const issued = await this.invite.execute(actor, card.link.id);
    const kb = new InlineKeyboard()
      .url(ctx.t('btn-open-invite-link'), issued.link)
      .row()
      .text(ctx.t('btn-revoke-invite'), sectionCb('students', 'pinvrevoke', issued.invitation.id))
      .text(ctx.t('btn-back'), sectionCb('students', 'parents', card.link.id));
    await say(
      ctx,
      ctx.t('invite-parent-card', {
        student: escapeHtml(card.student ? fullName(card.student) : cardDisplayName(card)),
        expires: formatDate(ctx, issued.invitation.expiresAt),
        link: issued.link,
      }),
      kb,
    );
  }

  /** Asks before an irreversible revocation that notifies everyone involved. */
  async confirmRevoke(ctx: BotContext, card: StudentCard, familyLinkId: string): Promise<boolean> {
    const parents = card.link.studentId ? await this.family.parentsOf(card.link.studentId) : [];
    const item = parents.find((p) => p.link.id === familyLinkId);
    if (!item) return false;
    const kb = new InlineKeyboard()
      .text(ctx.t('btn-confirm-unlink'), sectionCb('students', 'prevokeok', familyLinkId))
      .text(ctx.t('btn-cancel'), sectionCb('students', 'parents', card.link.id));
    await renderMenu(
      ctx,
      ctx.t('parent-unlink-teacher-confirm', {
        parent: escapeHtml(fullName(item.parent)),
        student: escapeHtml(cardDisplayName(card)),
      }),
      kb,
    );
    return true;
  }

  async revokeInvitation(ctx: BotContext, actor: Actor, invitationId: string): Promise<void> {
    await this.idempotent(ctx, () => this.invite.revoke(actor, invitationId), 'invite-revoked-ok');
  }

  async revokeFamilyLink(ctx: BotContext, actor: Actor, familyLinkId: string): Promise<void> {
    await this.idempotent(ctx, () => this.revokeLink.execute(actor, familyLinkId), 'parent-unlinked-ok');
  }

  /** A second tap on the same button must not surface an error (CONFLICT = already done). */
  private async idempotent(ctx: BotContext, action: () => Promise<unknown>, okKey: string): Promise<void> {
    try {
      await action();
      await ctx.answerCallbackQuery({ text: ctx.t(okKey) }).catch(() => undefined);
    } catch (error) {
      if (!AppError.is(error, 'CONFLICT')) throw error;
      await ctx.answerCallbackQuery({ text: ctx.t('parent-already-revoked') }).catch(() => undefined);
    }
  }
}
