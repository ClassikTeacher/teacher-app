import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Api, GrammyError } from 'grammy';
import {
  DOMAIN_EVENTS_QUEUE,
  QUEUES,
  type QueueRegistry,
  sendQueueName,
} from '@shared/queue/queue.module.js';
import { QueueModule } from '@shared/queue/queue.module.js';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount } from '@test/factories.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { OutboxConsumer } from '@modules/outbox/outbox.consumer.js';
import { OutboxPublisher } from '@modules/outbox/outbox.publisher.js';
import { outboxEvent } from '@modules/outbox/schema.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { BOT_APIS, BotApiModule, type BotApiRegistry } from '@telegram/api/bot-api.module.js';
import { NotificationRepository } from './notification.repository.js';
import { NotificationScheduler } from './notification.scheduler.js';
import { NotificationSender } from './notification.sender.js';
import { NotificationsModule } from './notifications.module.js';
import { notification } from './schema.js';

describe('outbox → queue → handler → notification → send (M1-07 acceptance)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let queues: QueueRegistry;
  let adminId: string;
  let teacherId: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [QueueModule, BotApiModule, NotificationsModule]);
    queues = ctx.get<QueueRegistry>(QUEUES);
    await queues.get(DOMAIN_EVENTS_QUEUE).obliterate({ force: true });
    await queues.get(sendQueueName('staff')).obliterate({ force: true });
    adminId = (await createAccount(tdb.txm, { roles: ['ADMIN'] })).id;
    teacherId = (
      await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Анна', lastName: 'П', username: 'anna' })
    ).id;
    await ctx.get(AccountRepository).upsertBotChat(adminId, 'staff', 4242);
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('publishes an event exactly once even when the publisher runs twice, and keeps it when the queue is down', async () => {
    const publisher = ctx.get(OutboxPublisher);
    const queue = queues.get(DOMAIN_EVENTS_QUEUE);
    const originalAdd = queue.add.bind(queue);

    await tdb.txm.run(async () => {
      await ctx.get(OutboxService).publish({
        type: 'teacher.onboarded',
        aggregateType: 'account',
        aggregateId: teacherId,
        payload: { accountId: teacherId, invitedBy: adminId },
      });
    });
    // queue unavailable: the event stays unpublished, attempts recorded
    queue.add = (() => Promise.reject(new Error('redis down'))) as typeof queue.add;
    expect(await publisher.publishPending()).toBe(0);
    let rows = await tdb.db.select().from(outboxEvent);
    expect(rows[0]).toMatchObject({ publishedAt: null, attempts: 1 });

    queue.add = originalAdd;
    expect(await publisher.publishPending()).toBe(1);
    expect(await publisher.publishPending()).toBe(0);
    rows = await tdb.db.select().from(outboxEvent);
    expect(rows[0]!.publishedAt).not.toBeNull();
    expect(await queue.getJobCountByTypes('waiting', 'delayed', 'active', 'completed')).toBe(1);

    // the consumer schedules admin notifications; redelivery of the same job is idempotent (dedupe_key)
    const job = (await queue.getJobs(['waiting']))[0]!;
    await ctx.get(OutboxConsumer).process({ data: job.data });
    await ctx.get(OutboxConsumer).process({ data: job.data });
    const scheduled = await tdb.db.select().from(notification).where(eq(notification.recipientId, adminId));
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      typeCode: 'admin.teacher_onboarded',
      bot: 'staff',
      status: 'scheduled',
    });
  });

  it('the scheduler queues due notifications once; the sender delivers through the bot API and records the status', async () => {
    const scheduler = ctx.get(NotificationScheduler);
    expect(await scheduler.tick()).toBe(1);
    expect(await scheduler.tick()).toBe(0);
    const [row] = await tdb.db.select().from(notification).where(eq(notification.recipientId, adminId));
    expect(row?.status).toBe('queued');

    const sent: Array<{ chatId: number; text: string }> = [];
    const fakeApi = new Api('1:fake');
    fakeApi.config.use(async (_prev, method, payload) => {
      if (method === 'sendMessage')
        sent.push({
          chatId: Number((payload as { chat_id: number }).chat_id),
          text: String((payload as { text: string }).text),
        });
      return { ok: true, result: { message_id: 1 } } as never;
    });
    ctx.get<BotApiRegistry>(BOT_APIS).set('staff', fakeApi);

    const sender = ctx.get(NotificationSender);
    expect(await sender.process('staff', { data: { notificationId: row!.id }, attemptsMade: 0 })).toBe(
      'sent',
    );
    expect(sent).toEqual([{ chatId: 4242, text: expect.stringContaining('Анна П') }]);
    expect((await ctx.get(NotificationRepository).findById(row!.id))?.status).toBe('sent');
    // a duplicate job for an already sent notification is a no-op
    expect(await sender.process('staff', { data: { notificationId: row!.id }, attemptsMade: 0 })).toBe(
      'skipped',
    );
  });

  it('403 from Telegram marks the chat unreachable and the notification failed (NTF-09)', async () => {
    const repo = ctx.get(NotificationRepository);
    const n = await repo.insert({
      typeCode: 'account.unblocked',
      recipientId: adminId,
      bot: 'staff',
      payload: {},
      dedupeKey: 'test:403',
      dueAt: new Date(),
    });
    await repo.setStatus([n!.id], 'queued');
    const blockingApi = new Api('1:fake');
    blockingApi.config.use(
      async () =>
        ({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }) as never,
    );
    ctx.get<BotApiRegistry>(BOT_APIS).set('staff', blockingApi);
    await expect(
      ctx.get(NotificationSender).process('staff', { data: { notificationId: n!.id }, attemptsMade: 0 }),
    ).rejects.toThrow(/blocked/);
    expect((await repo.findById(n!.id))?.status).toBe('failed');
    expect((await ctx.get(AccountRepository).findBotChat(adminId, 'staff'))?.isReachable).toBe(false);
    expect(GrammyError).toBeDefined();
  });
});

describe('M1-07 review: stuck rows, odd dedupe keys, terminal 4xx', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let adminId: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [QueueModule, BotApiModule, NotificationsModule]);
    await ctx.get<QueueRegistry>(QUEUES).get(sendQueueName('staff')).obliterate({ force: true });
    adminId = (await createAccount(tdb.txm, { roles: ['ADMIN'] })).id;
    await ctx.get(AccountRepository).upsertBotChat(adminId, 'staff', 777);
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('queues keys with 2 and 4 colon-separated parts (BullMQ forbids ":" in job ids)', async () => {
    const repo = ctx.get(NotificationRepository);
    await repo.insert({
      typeCode: 'account.unblocked',
      recipientId: adminId,
      bot: 'staff',
      payload: {},
      dedupeKey: 'account.unblocked:evt',
      dueAt: ctx.clock.now(),
    });
    await repo.insert({
      typeCode: 'account.unblocked',
      recipientId: adminId,
      bot: 'staff',
      payload: {},
      dedupeKey: 'lesson.reminder:l:60:3',
      dueAt: ctx.clock.now(),
    });
    expect(await ctx.get(NotificationScheduler).tick()).toBe(2);
  });

  it('reconciles rows stuck in sending or queued back to scheduled', async () => {
    const repo = ctx.get(NotificationRepository);
    const stuck = (await repo.insert({
      typeCode: 'account.unblocked',
      recipientId: adminId,
      bot: 'staff',
      payload: {},
      dedupeKey: 'stuck:sending',
      dueAt: ctx.clock.now(),
    }))!;
    await repo.setStatus([stuck.id], 'sending');
    // the set_updated_at trigger would overwrite the backdate; disable triggers for this one statement
    await tdb.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(
        sql`UPDATE notification SET updated_at = ${new Date(ctx.clock.now().getTime() - 10 * 60_000)} WHERE id = ${stuck.id}`,
      );
    });
    expect(await ctx.get(NotificationScheduler).reconcile()).toBe(1);
    expect((await repo.findById(stuck.id))?.status).toBe('scheduled');
    expect(await ctx.get(NotificationScheduler).reconcile()).toBe(0);
  });

  it('a 400 from Telegram is terminal; cancelByPrefix stops not-yet-sent rows', async () => {
    const repo = ctx.get(NotificationRepository);
    const n = (await repo.insert({
      typeCode: 'account.unblocked',
      recipientId: adminId,
      bot: 'staff',
      payload: {},
      dedupeKey: 'bad:entities',
      dueAt: ctx.clock.now(),
    }))!;
    await repo.setStatus([n.id], 'queued');
    const api = new Api('1:fake');
    api.config.use(
      async () => ({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }) as never,
    );
    ctx.get<BotApiRegistry>(BOT_APIS).set('staff', api);
    await expect(
      ctx.get(NotificationSender).process('staff', { data: { notificationId: n.id }, attemptsMade: 0 }),
    ).rejects.toThrow(/parse entities/);
    expect(await repo.findById(n.id)).toMatchObject({
      status: 'failed',
      error: "Bad Request: can't parse entities",
    });

    await repo.insert({
      typeCode: 'account.unblocked',
      recipientId: adminId,
      bot: 'staff',
      payload: {},
      dedupeKey: 'lesson.reminder:L1:60:1',
      dueAt: new Date(ctx.clock.now().getTime() + 60_000),
    });
    await repo.insert({
      typeCode: 'account.unblocked',
      recipientId: adminId,
      bot: 'staff',
      payload: {},
      dedupeKey: 'lesson.reminder:L1:1440:1',
      dueAt: new Date(ctx.clock.now().getTime() + 60_000),
    });
    expect(await repo.cancelByPrefix('lesson.reminder:L1:')).toBe(2);
    expect(await repo.cancelByPrefix('lesson.reminder:L_:')).toBe(0);
  });
});
