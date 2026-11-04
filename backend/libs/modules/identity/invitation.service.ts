import { Inject, Injectable } from '@nestjs/common';
import { botConfigs, ENV, type Env } from '@shared/config/index.js';
import { AppError } from '@shared/errors/app-error.js';
import { addHours } from '@shared/time/clock.js';
import { InvitationRepository } from './invitation.repository.js';
import {
  checkRedeemable,
  generateInvitationToken,
  hashInvitationToken,
  INVITATION_BOT,
  INVITATION_TOKEN,
  INVITATION_TTL_HOURS,
  type InvitationCheck,
  invitationDeepLink,
} from './invitation.rules.js';
import type { InvitationKind, InvitationPayload, InvitationRow } from './schema.js';

export interface CreateInvitationInput {
  kind: InvitationKind;
  createdBy: string | null;
  targetTelegramUserId?: number | null;
  payload?: InvitationPayload;
  maxUses?: number;
  ttlHours?: number;
}

export interface IssuedInvitation {
  invitation: InvitationRow;
  /** Plain token: returned exactly once, never stored (INV-05). */
  token: string;
  link: string;
}

/** Safe projection for showing an invitation before it is accepted (no token hash). */
export interface PeekedInvitation {
  id: string;
  kind: InvitationKind;
  createdBy: string | null;
  payload: InvitationPayload;
  expiresAt: Date;
  check: InvitationCheck;
}

/** Token lifecycle shared by staff, student and parent invitations. Business rules per kind live in use-cases. */
@Injectable()
export class InvitationService {
  constructor(
    private readonly invitations: InvitationRepository,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async create(input: CreateInvitationInput, now: Date): Promise<IssuedInvitation> {
    const token = generateInvitationToken();
    const row = await this.invitations.insert({
      tokenHash: hashInvitationToken(token),
      kind: input.kind,
      createdBy: input.createdBy,
      targetTelegramUserId: input.targetTelegramUserId ?? null,
      payload: input.payload ?? {},
      maxUses: input.maxUses ?? 1,
      expiresAt: addHours(now, input.ttlHours ?? INVITATION_TTL_HOURS[input.kind]),
    });
    return { invitation: row, token, link: this.linkFor(row.kind, token) };
  }

  linkFor(kind: InvitationKind, token: string): string {
    return invitationDeepLink(botConfigs(this.env)[INVITATION_BOT[kind]].username, token);
  }

  /** Read-only validation for showing "X invites you" before the user accepts. */
  async peek(token: string, telegramUserId: number, now: Date): Promise<PeekedInvitation | null> {
    if (!INVITATION_TOKEN.test(token)) return null;
    const row = await this.invitations.findByTokenHash(hashInvitationToken(token));
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      createdBy: row.createdBy,
      payload: row.payload,
      expiresAt: row.expiresAt,
      check: checkRedeemable(row, now, telegramUserId),
    };
  }

  /**
   * Atomically consumes one use of the invitation. Must run inside the caller's transaction:
   * the row is locked so two concurrent redeems of a one-time link cannot both succeed.
   * `usedBy` is null when a stranger declines a link (the token is burnt without creating an account).
   */
  async redeem(
    token: string,
    telegramUserId: number,
    usedBy: string | null,
    now: Date,
  ): Promise<InvitationRow> {
    if (!INVITATION_TOKEN.test(token)) throw new AppError('INVITATION_INVALID', 'Invitation is not valid');
    const row = await this.invitations.findByTokenHash(hashInvitationToken(token), { forUpdate: true });
    if (!row) throw new AppError('INVITATION_INVALID', 'Invitation is not valid');
    const check = checkRedeemable(row, now, telegramUserId);
    if (!check.ok) {
      if (check.reason === 'not_for_you') {
        throw new AppError('INVITATION_NOT_FOR_YOU', 'Invitation is addressed to someone else');
      }
      throw new AppError('INVITATION_INVALID', 'Invitation is not valid', { reason: check.reason });
    }
    await this.invitations.markUsed(row.id, usedBy, now, row.usedCount + 1 >= row.maxUses);
    return { ...row, usedCount: row.usedCount + 1, usedBy, usedAt: now };
  }

  async revoke(id: string, revokedBy: string | null, now: Date): Promise<InvitationRow> {
    const row = await this.invitations.revoke(id, revokedBy, now);
    if (!row) throw new AppError('CONFLICT', 'Invitation is not pending');
    return row;
  }
}
