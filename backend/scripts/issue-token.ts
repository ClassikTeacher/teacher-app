import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigModule, loadDotEnv, parseEnv } from '@shared/config/index.js';
import { DbModule } from '@shared/db/index.js';
import { AccessModule } from '@modules/access/access.module.js';
import { AuthTokenService, MAX_TOKEN_TTL_SECONDS } from '@modules/access/http/auth-token.service.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { IdentityModule } from '@modules/identity/identity.module.js';

@Module({ imports: [ConfigModule, DbModule, IdentityModule, AccessModule] })
class TokenModule {}

/**
 * Dev/ops helper: `pnpm token:issue <accountId> [ttlSeconds] [--force]` prints a bearer token for REST calls.
 * Refuses to run in production without `--force`; ttl is capped at 24 h; the account must exist and be active.
 */
async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') loadDotEnv();
  const env = parseEnv(process.env);
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const [accountId, ttlArg] = args.filter((a) => !a.startsWith('--'));
  if (!accountId) throw new Error('usage: pnpm token:issue <accountId> [ttlSeconds] [--force]');
  if (env.NODE_ENV === 'production' && !force) {
    throw new Error('refusing to mint a token in production without --force (tokens are a stage-2 feature)');
  }
  const ttl = ttlArg === undefined ? undefined : Number(ttlArg);
  if (ttl !== undefined && (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_TOKEN_TTL_SECONDS)) {
    throw new Error(`ttlSeconds must be an integer between 1 and ${MAX_TOKEN_TTL_SECONDS}`);
  }
  const app = await NestFactory.createApplicationContext(TokenModule, { logger: ['error'] });
  try {
    const account = await app.get(AccountRepository).findById(accountId);
    if (!account) throw new Error(`account ${accountId} not found`);
    if (account.status !== 'active') throw new Error(`account ${accountId} is ${account.status}, not active`);
    console.error(`issuing token for account ${accountId} (ttl ${ttl ?? 900}s)`);
    console.log(await app.get(AuthTokenService).issue(accountId, ttl));
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
