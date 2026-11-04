import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '@test/app.js';
import { createBotHarness, type BotHarness } from '@test/bot.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount, nextTelegramUserId } from '@test/factories.js';
import { linkStudent, MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import { FeatureAdminUseCase } from '@modules/access/features/feature-admin.use-case.js';
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import { outboxEvent } from '@modules/outbox/schema.js';
import { GroupRepository } from '@modules/people/groups/group.repository.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { TelegramModule } from '../../telegram.module.js';
import { StaffBot } from '../staff-bot.js';

describe('UC-12: teacher creates a group and manages its members in StaffBot', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let h: BotHarness;
  let teacherId: string;
  const tg = nextTelegramUserId();
  const teacher = () => ({ id: tg, first_name: 'Анна' });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [PeopleModule, AccessModule, TelegramModule]);
    h = createBotHarness(ctx.get(StaffBot), ctx.get(ActorResolver));
    teacherId = (await createAccount(tdb.txm, { telegramUserId: tg, roles: ['TEACHER'], firstName: 'Анна' }))
      .id;
    await ctx
      .get(TeacherProfileRepository)
      .upsert(teacherId, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now() });
    for (const name of ['Петя', 'Маша']) {
      const s = await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: name, lastName: 'Иванов' });
      await linkStudent(ctx, teacherId, s.id);
    }
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('create → add two members → remove one → events emitted → archive with confirmation', async () => {
    await h.text(teacher(), '/menu');
    await h.press(teacher(), '🧑‍🤝‍🧑 Группы');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Групп пока нет');
    await h.press(teacher(), '➕ Создать группу');
    await h.text(teacher(), '10А математика');
    await h.press(teacher(), 'Математика');
    await h.text(teacher(), '🔢');
    await h.press(teacher(), '90');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Группа «10А математика» создана');

    await h.press(teacher(), '👥 Состав');
    expect(h.tg.findButton('➕ Петя Иванов', tg)).toBeDefined();
    await h.press(teacher(), '➕ Петя Иванов');
    await h.press(teacher(), '➕ Маша Иванов');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Состав: 10А математика</b> · 2');
    expect(h.tg.findButton('➖ Петя Иванов', tg)).toBeDefined();
    const stale = h.tg.findButton('➖ Маша Иванов', tg)!.callback_data!;
    await h.press(teacher(), '➖ Маша Иванов');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('· 1');
    await h.callback(teacher(), stale); // a remove button from the old list no longer matches: refused as stale
    const answer = h.tg.calls.filter((c) => c.method === 'answerCallbackQuery').at(-1);
    expect(answer?.payload['text']).toContain('устарела');

    const groups = await ctx.get(GroupRepository).listByTeacher(teacherId, { archived: false });
    expect(groups[0]).toMatchObject({
      name: '10А математика',
      emoji: '🔢',
      defaultDurationMin: 90,
      subjectId: MATH_ID,
    });
    const events = await tdb.db.select().from(outboxEvent).where(eq(outboxEvent.aggregateId, groups[0]!.id));
    expect(events.map((e) => e.eventType)).toEqual([
      'group.member_added',
      'group.member_added',
      'group.member_removed',
    ]);

    await h.press(teacher(), '◀️ Назад');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Участников: 1');
    await h.press(teacher(), '🗂 В архив');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('в архив?');
    await h.press(teacher(), 'Да, в архив');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Групп пока нет');
    expect(await ctx.get(GroupRepository).listMembers(groups[0]!.id)).toHaveLength(0);
  });

  it('a duplicate name and a disabled feature are explained; another teacher cannot open the group', async () => {
    await h.text(teacher(), '/menu');
    await h.press(teacher(), '🧑‍🤝‍🧑 Группы');
    await h.press(teacher(), '➕ Создать группу');
    await h.text(teacher(), 'Группа А');
    await h.press(teacher(), 'Пропустить');
    await h.press(teacher(), 'Пропустить');
    await h.press(teacher(), 'Пропустить');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('создана');
    await h.press(teacher(), '◀️ Назад');
    await h.press(teacher(), '◀️ Назад');
    await h.press(teacher(), '➕ Создать группу');
    await h.text(teacher(), 'группа а');
    await h.press(teacher(), 'Пропустить');
    await h.press(teacher(), 'Пропустить');
    await h.press(teacher(), 'Пропустить');
    // a duplicate name sends the teacher back to the name step with the typed data kept
    expect(h.tg.sentTexts(tg).at(-2)).toContain('уже есть');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Новая группа, шаг 1');
    await h.text(teacher(), 'Группа Б');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Шаг 2');
    await h.press(teacher(), 'Пропустить');
    await h.press(teacher(), 'Пропустить');
    await h.press(teacher(), 'Пропустить');
    expect(h.tg.sentTexts(tg).at(-1)).toContain('Группа «Группа Б» создана');

    const other = await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Олег' });
    const groups = await ctx.get(GroupRepository).listByTeacher(teacherId, { archived: false });
    await h.callback({ id: other.telegramUserId, first_name: 'Олег' }, `s:groups:card:${groups[0]!.id}`);
    expect(h.tg.sentTexts(other.telegramUserId).at(-1)).toContain('Групп пока нет');

    const admin = await createAccount(tdb.txm, { roles: ['ADMIN'] });
    await ctx
      .get(FeatureAdminUseCase)
      .setTeacher(
        { accountId: admin.id, roles: ['ADMIN'], status: 'active', source: 'bot' },
        teacherId,
        'groups',
        { enabled: false },
      );
    await h.text(teacher(), '/menu');
    expect(h.tg.findButton('🧑‍🤝‍🧑 Группы', tg)).toBeUndefined();
  });
});
