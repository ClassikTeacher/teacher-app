import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@test/app.js';
import { createBotHarness, type BotHarness } from '@test/bot.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount, nextTelegramUserId } from '@test/factories.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { SuperAdminTransferUseCase } from '@modules/identity/super-admin-transfer.use-case.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TelegramModule } from '../telegram.module.js';
import { AuthBot } from './auth-bot.js';

describe('UC-02 in AuthBot: the designated admin confirms the transfer', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let h: BotHarness;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [PeopleModule, TelegramModule]);
    h = createBotHarness(ctx.get(AuthBot), ctx.get(ActorResolver));
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('/start shows the pending transfer with buttons; confirming moves the role', async () => {
    const saTg = nextTelegramUserId();
    const adminTg = nextTelegramUserId();
    const sa = await createAccount(tdb.txm, { telegramUserId: saTg, roles: ['SUPER_ADMIN'] });
    const admin = await createAccount(tdb.txm, { telegramUserId: adminTg, roles: ['ADMIN'] });
    const transfer = await ctx
      .get(SuperAdminTransferUseCase)
      .request({ toAccountId: admin.id, previousRole: 'ADMIN' });

    const stranger = { id: saTg, first_name: 'SA' };
    await h.text(stranger, '/start');
    expect(h.tg.sentTexts(saTg).at(-1)).toContain('уже зарегистрированы');

    const user = { id: adminTg, first_name: 'Админ' };
    await h.text(user, '/start');
    expect(h.tg.sentTexts(adminTg).at(-1)).toContain('роль суперадминистратора');
    await h.press(user, '✅ Принять роль');
    expect(h.tg.sentTexts(adminTg).at(-1)).toContain('теперь вы суперадминистратор');
    const repo = ctx.get(AccountRepository);
    expect((await repo.activeRoles(admin.id)).sort()).toEqual(['ADMIN', 'SUPER_ADMIN']);
    expect(await repo.activeRoles(sa.id)).toEqual(['ADMIN']);

    // a second press of the old button is a conflict, reported through the error boundary, not a crash
    await h.callback(user, `m:sat:confirm:${transfer.id}`);
    expect(h.tg.sentTexts(adminTg).at(-1)).toContain('уже выполнено');
  });
});
