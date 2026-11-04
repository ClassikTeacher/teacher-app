import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '@shared/db/drizzle.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount, nextTelegramUserId } from '@test/factories.js';
import { AccountRepository } from './account.repository.js';

describe('AccountRepository (integration)', () => {
  let tdb: TestDatabase;
  let repo: AccountRepository;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    repo = new AccountRepository(tdb.txm);
  });

  afterAll(async () => {
    await tdb.drop();
  });

  it('creates an account through the migrated schema and reads it back by Telegram id', async () => {
    const telegramUserId = nextTelegramUserId();
    const created = await repo.insert({
      telegramUserId,
      firstName: 'Анна',
      lastName: 'Петровна',
      status: 'invited',
    });

    const found = await repo.findByTelegramUserId(telegramUserId);

    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.status).toBe('invited');
    expect(found!.timezone).toBe('Europe/Minsk');
    expect(found!.createdAt).toBeInstanceOf(Date);
  });

  it('enforces one account per Telegram user', async () => {
    const telegramUserId = nextTelegramUserId();
    await repo.insert({ telegramUserId });

    await expect(repo.insert({ telegramUserId })).rejects.toSatisfy(
      (e) => pgErrorCode(e) === PG_UNIQUE_VIOLATION,
    );
  });

  it('allows exactly one active SUPER_ADMIN on the platform', async () => {
    const first = await createAccount(tdb.txm, { roles: ['SUPER_ADMIN'] });
    const second = await createAccount(tdb.txm);

    await expect(repo.grantRole(second.id, 'SUPER_ADMIN', null)).rejects.toSatisfy(
      (e) => pgErrorCode(e) === PG_UNIQUE_VIOLATION,
    );

    await repo.revokeRole(first.id, 'SUPER_ADMIN', null);
    await expect(repo.grantRole(second.id, 'SUPER_ADMIN', null)).resolves.toMatchObject({
      role: 'SUPER_ADMIN',
    });
    expect(await repo.activeRoles(first.id)).toEqual([]);
    expect(await repo.activeRoles(second.id)).toEqual(['SUPER_ADMIN']);
  });

  it('rolls back everything written inside a failed transaction', async () => {
    const telegramUserId = nextTelegramUserId();

    await expect(
      tdb.txm.run(async () => {
        await repo.insert({ telegramUserId });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await repo.findByTelegramUserId(telegramUserId)).toBeNull();
  });

  it('runs afterCommit hooks only once the outer transaction commits', async () => {
    const events: string[] = [];
    await tdb.txm.run(async () => {
      await tdb.txm.afterCommit(() => {
        events.push('committed');
      });
      await tdb.txm.run(async () => {
        events.push('inner');
      });
      events.push('outer-end');
    });
    expect(events).toEqual(['inner', 'outer-end', 'committed']);
  });

  it('upserts the bot chat channel and marks it unreachable', async () => {
    const acc = await createAccount(tdb.txm);
    await repo.upsertBotChat(acc.id, 'staff', 555);
    await repo.upsertBotChat(acc.id, 'staff', 556);
    await repo.markBotChatUnreachable(acc.id, 'staff', '403: bot was blocked by the user');

    const chat = await repo.findBotChat(acc.id, 'staff');
    expect(chat).toMatchObject({
      chatId: 556,
      isReachable: false,
      lastError: '403: bot was blocked by the user',
    });
  });
});

describe('TransactionManager (integration)', () => {
  let tdb: TestDatabase;
  let repo: AccountRepository;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    repo = new AccountRepository(tdb.txm);
  });

  afterAll(async () => {
    await tdb.drop();
  });

  it('keeps the outer transaction alive when a savepoint fails', async () => {
    const keep = nextTelegramUserId();
    const lost = nextTelegramUserId();
    await tdb.txm.run(async () => {
      await repo.insert({ telegramUserId: keep });
      await expect(
        tdb.txm.runSavepoint(async () => {
          await repo.insert({ telegramUserId: lost });
          throw new Error('inner');
        }),
      ).rejects.toThrow('inner');
    });
    expect(await repo.findByTelegramUserId(keep)).not.toBeNull();
    expect(await repo.findByTelegramUserId(lost)).toBeNull();
  });

  it('drops afterCommit hooks registered inside a failed savepoint and isolates hook failures', async () => {
    const events: string[] = [];
    await tdb.txm.run(async () => {
      await tdb.txm.afterCommit(() => {
        throw new Error('hook failed');
      });
      await tdb.txm.afterCommit(() => {
        events.push('second');
      });
      await tdb.txm
        .runSavepoint(async () => {
          await tdb.txm.afterCommit(() => {
            events.push('never');
          });
          throw new Error('rollback');
        })
        .catch(() => undefined);
    });
    expect(events).toEqual(['second']);
  });

  it('refuses database access from a fire-and-forget promise that outlives the transaction', async () => {
    let leaked: Promise<unknown> | undefined;
    await tdb.txm.run(async () => {
      leaked = new Promise((r) => setTimeout(r, 30)).then(() => repo.findByTelegramUserId(1));
    });
    await expect(leaked!).rejects.toThrow(/already completed/);
  });
});
