import { AccountRepository, type NewAccount, type Role } from '../libs/modules/identity/index.js';
import type { TransactionManager } from '../libs/shared/src/db/transaction-manager.js';

let telegramSeq = 100_000;

/** Deterministic, unique Telegram user ids for test accounts. */
export function nextTelegramUserId(): number {
  telegramSeq += 1;
  return telegramSeq;
}

export async function createAccount(
  txm: TransactionManager,
  overrides: Partial<NewAccount> & { roles?: Role[] } = {},
) {
  const repo = new AccountRepository(txm);
  const { roles = [], ...data } = overrides;
  const row = await repo.insert({
    telegramUserId: nextTelegramUserId(),
    firstName: 'Test',
    lastName: 'User',
    status: 'active',
    ...data,
  });
  for (const role of roles) {
    await repo.grantRole(row.id, role, null);
  }
  return row;
}
