import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@test/app.js';
import { createBotHarness, type BotHarness } from '@test/bot.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount, nextTelegramUserId } from '@test/factories.js';
import type { Actor } from '@modules/access/actor.js';
import { AccessModule } from '@modules/access/access.module.js';
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { InviteStaffUseCase } from '@modules/identity/invite-staff.use-case.js';
import { FileTypeRepository } from '@modules/people/file-type.repository.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { SubjectRepository } from '@modules/people/subject.repository.js';
import { AuthBot } from '../../auth-bot/auth-bot.js';
import { TelegramModule } from '../../telegram.module.js';
import { StaffBot } from '../staff-bot.js';

describe('UC-44: catalogues maintained by admins reach the teacher onboarding', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let staff: BotHarness;
  let auth: BotHarness;
  let adminTg: number;
  let admin: Actor;
  const adminUser = () => ({ id: adminTg, first_name: 'Админ', username: 'admin' });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [PeopleModule, AccessModule, TelegramModule]);
    staff = createBotHarness(ctx.get(StaffBot), ctx.get(ActorResolver));
    auth = createBotHarness(ctx.get(AuthBot), ctx.get(ActorResolver));
    adminTg = nextTelegramUserId();
    const row = await createAccount(tdb.txm, { telegramUserId: adminTg, roles: ['ADMIN'] });
    admin = { accountId: row.id, roles: ['ADMIN'], status: 'active', source: 'bot' };
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('admin adds a subject in StaffBot; a new teacher sees it in the onboarding picker', async () => {
    await staff.text(adminUser(), '/menu');
    await staff.press(adminUser(), '🛠 Администрирование');
    await staff.press(adminUser(), '📖 Предметы');
    expect(staff.tg.sentTexts(adminTg).at(-1)).toContain('Предметы');
    await staff.press(adminUser(), '➕ Добавить предмет');
    await staff.text(adminUser(), 'Астрономия');
    expect(staff.tg.sentTexts(adminTg).at(-1)).toContain('«Астрономия» добавлен');
    expect(await ctx.get(SubjectRepository).findByName('астрономия')).toMatchObject({ isActive: true });

    await staff.press(adminUser(), '◀️ Назад');
    await staff.press(adminUser(), /🟢 Физика/);
    expect(staff.tg.findButton(/⚪️ Физика/, adminTg)).toBeDefined();

    const issued = await ctx.get(InviteStaffUseCase).execute(admin, { role: 'TEACHER' });
    const teacher = { id: nextTelegramUserId(), first_name: 'Новый', username: 'newbie' };
    await auth.text(teacher, `/start ${issued.token}`);
    await auth.press(teacher, /Оставить/);
    const page1 = auth.tg
      .lastKeyboard(teacher.id)
      .flat()
      .map((b) => b.text);
    expect(page1).not.toContain('Физика');
    await auth.press(teacher, '▶️'); // the new subject sorts last (position 1000), on the second page
    const page2 = auth.tg
      .lastKeyboard(teacher.id)
      .flat()
      .map((b) => b.text);
    expect([...page1, ...page2]).toContain('Астрономия');
  });

  it('admin toggles an allowed file type', async () => {
    await staff.text(adminUser(), '/menu');
    await staff.press(adminUser(), '🛠 Администрирование');
    await staff.press(adminUser(), '📎 Типы файлов');
    expect(staff.tg.findButton('🟢 .pdf', adminTg)).toBeDefined();
    await staff.press(adminUser(), '▶️'); // archives sit on the second page (15 per page)
    expect(staff.tg.findButton('⚪️ .zip', adminTg)).toBeDefined();
    await staff.press(adminUser(), '⚪️ .zip');
    expect(staff.tg.findButton('🟢 .zip', adminTg)).toBeDefined();
    expect((await ctx.get(FileTypeRepository).find('zip'))?.isAllowed).toBe(true);
    await staff.press(adminUser(), '◀️');
    await staff.press(adminUser(), '🟢 .pdf');
    expect((await ctx.get(FileTypeRepository).find('pdf'))?.isAllowed).toBe(false);
    expect(staff.tg.findButton('⚪️ .pdf', adminTg)).toBeDefined(); // stays on the same page
  });
});
