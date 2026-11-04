import { Injectable } from '@nestjs/common';
import type { Actor, ActorSource } from '@modules/access/actor.js';
import { AccountRepository } from './account.repository.js';
import type { AccountRow } from './schema.js';

export interface ResolvedActor {
  actor: Actor;
  account: AccountRow;
}

/** Builds the Actor (roles + status) for a Telegram user or an account id. */
@Injectable()
export class ActorResolver {
  constructor(private readonly accounts: AccountRepository) {}

  async byTelegramUserId(telegramUserId: number, source: ActorSource = 'bot'): Promise<ResolvedActor | null> {
    const account = await this.accounts.findByTelegramUserId(telegramUserId);
    return account ? this.resolve(account, source) : null;
  }

  async byAccountId(accountId: string, source: ActorSource = 'api'): Promise<ResolvedActor | null> {
    const account = await this.accounts.findById(accountId);
    return account ? this.resolve(account, source) : null;
  }

  private async resolve(account: AccountRow, source: ActorSource): Promise<ResolvedActor> {
    const roles = await this.accounts.activeRoles(account.id);
    return { account, actor: { accountId: account.id, roles, status: account.status, source } };
  }
}
