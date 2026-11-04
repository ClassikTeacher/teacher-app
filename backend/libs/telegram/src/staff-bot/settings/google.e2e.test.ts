import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@test/app.js';
import { createBotHarness, type BotHarness } from '@test/bot.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount, nextTelegramUserId } from '@test/factories.js';
import { FakeGoogleApi, GOOGLE_TEST_ENV } from '@test/google.js';
import { MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import type { Actor } from '@modules/access/actor.js';
import { FeatureAdminUseCase } from '@modules/access/features/feature-admin.use-case.js';
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { GOOGLE_API } from '@modules/integrations/google/google-api.js';
import { GoogleCalendarUseCase } from '@modules/integrations/google/google-calendar.use-case.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { TelegramModule } from '../../telegram.module.js';
import { StaffBot } from '../staff-bot.js';

describe('StaffBot → Настройки → Google Calendar (UC-43, E2-05)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let h: BotHarness;
  let google: FakeGoogleApi;
  let teacherId: string;
  let adminId: string;
  const tg = nextTelegramUserId();
  const anna = () => ({ id: tg, first_name: 'Анна' });
  const last = (): string => h.tg.sentTexts(tg).at(-1) ?? '';
  const admin = (): Actor => ({ accountId: adminId, roles: ['ADMIN'], status: 'active', source: 'bot' });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    google = new FakeGoogleApi();
    ctx = await createTestContext(tdb, [PeopleModule, AccessModule, ScheduleModule, TelegramModule], {
      env: GOOGLE_TEST_ENV,
      overrides: [{ token: GOOGLE_API, value: google }],
    });
    h = createBotHarness(ctx.get(StaffBot), ctx.get(ActorResolver));
    teacherId = (await createAccount(tdb.txm, { telegramUserId: tg, roles: ['TEACHER'], firstName: 'Анна' }))
      .id;
    await ctx
      .get(TeacherProfileRepository)
      .upsert(teacherId, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now() });
    adminId = (await createAccount(tdb.txm, { roles: ['ADMIN'] })).id;
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('hides the menu item while the feature is off, then offers the consent link as a URL button', async () => {
    await h.text(anna(), '/menu');
    await h.press(anna(), '⚙️ Настройки');
    expect(h.tg.findButton('📆 Google Calendar', tg)).toBeUndefined();
    await ctx.get(FeatureAdminUseCase).setTeacher(admin(), teacherId, 'calendar.google', { enabled: true });
    await h.press(anna(), '◀️ Назад');
    await h.press(anna(), '⚙️ Настройки');
    await h.press(anna(), '📆 Google Calendar');
    expect(last()).toContain('Платформа создаст в вашем Google-аккаунте отдельный календарь');
    await h.press(anna(), '🔗 Подключить Google');
    expect(last()).toContain('подтвердите <b>оба</b> разрешения');
    const button = h.tg.findButton('🌐 Открыть страницу Google', tg);
    expect(button?.url).toContain('https://accounts.google.com/o/oauth2/v2/auth?');
    expect(button?.callback_data).toBeUndefined();
    // the browser finishes the flow (the callback endpoint); the bot then shows the connected state
    const state = new URL(button!.url!).searchParams.get('state')!;
    google.codes.set('c1', { email: 'anna@gmail.com' });
    await ctx.get(GoogleCalendarUseCase).completeOAuth(state, 'c1');
    await h.press(anna(), '◀️ Назад');
    expect(last()).toContain('🟢 подключён');
    expect(last()).toContain('Аккаунт: anna@gmail.com');
    expect(last()).toContain('Импорт занятости: вкл');
  });

  it('toggles import/export, asks for a sync and disconnects with confirmation', async () => {
    await h.press(anna(), '☑️ Импорт занятости');
    expect(last()).toContain('Импорт занятости: выкл');
    expect(h.tg.findButton('⬜ Импорт занятости', tg)).toBeDefined();
    await h.press(anna(), '⬜ Импорт занятости');
    expect(last()).toContain('Импорт занятости: вкл');
    await h.press(anna(), '🔄 Синхронизировать');
    expect(last()).toContain('🟢 подключён');
    await h.press(anna(), '⛔ Отключить');
    expect(last()).toContain('Отключить Google Calendar?');
    await h.press(anna(), '⛔ Да, отключить');
    expect(last()).toContain('Платформа создаст'); // back to the intro: not connected
    expect(h.tg.findButton('🔗 Подключить Google', tg)).toBeDefined();
    expect(google.revoked.size).toBe(1);
  });

  it('shows the feature-disabled message when the flag goes off in the middle of the screen', async () => {
    await ctx.get(FeatureAdminUseCase).setTeacher(admin(), teacherId, 'calendar.google', { enabled: false });
    await h.press(anna(), '🔗 Подключить Google');
    expect(last()).toContain('Эта функция отключена администратором');
  });
});
