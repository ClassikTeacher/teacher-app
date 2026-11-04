import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DAY_MS } from '@shared/time/clock.js';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount } from '@test/factories.js';
import { drainOutbox } from '@test/outbox.js';
import { linkStudent } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import type { Actor } from '@modules/access/actor.js';
import { notification } from '@modules/notifications/schema.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { DomainEventBus } from '@modules/outbox/event-bus.js';
import { outboxEvent } from '@modules/outbox/schema.js';
import { FamilyLinkRepository } from '../family/family-link.repository.js';
import { PeopleModule } from '../people.module.js';
import { EndLinkUseCase } from './end-link.use-case.js';
import { LeaveRequestRepository } from './leave-request.repository.js';
import { LeaveRequestUseCase } from './leave-request.use-case.js';
import { TeacherStudentRepository } from './teacher-student.repository.js';

describe('Leave requests and link ending: consent guard, lock order, reminders, idempotency', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let leaves: LeaveRequestUseCase;
  let endLink: EndLinkUseCase;
  let links: TeacherStudentRepository;
  const actor = (id: string, roles: Actor['roles']): Actor => ({
    accountId: id,
    roles,
    status: 'active',
    source: 'bot',
  });

  async function setup() {
    const t = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    const s = await createAccount(tdb.txm, { roles: ['STUDENT'] });
    const p = await createAccount(tdb.txm, { roles: ['PARENT'] });
    await ctx.get(FamilyLinkRepository).insert({
      parentId: p.id,
      studentId: s.id,
      invitedBy: t.id,
      invitationId: null,
      confirmedAt: ctx.clock.now(),
    });
    const link = await linkStudent(ctx, t.id, s.id);
    return {
      teacher: actor(t.id, ['TEACHER']),
      student: actor(s.id, ['STUDENT']),
      parent: actor(p.id, ['PARENT']),
      link,
      ids: { t: t.id, s: s.id, p: p.id },
    };
  }

  const requestIdOf = (outcome: Awaited<ReturnType<LeaveRequestUseCase['request']>>): string =>
    outcome.kind === 'requested' ? outcome.request.id : '';

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [PeopleModule, AccessModule, NotificationsModule]);
    leaves = ctx.get(LeaveRequestUseCase);
    endLink = ctx.get(EndLinkUseCase);
    links = ctx.get(TeacherStudentRepository);
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('a student with a parent cannot end directly; a parent cannot use left_by_student without an approved request', async () => {
    const { student, parent, link } = await setup();
    const direct = { reason: 'left_by_student' as const, message: 'x' };
    await expect(endLink.execute(student, link.id, direct)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(endLink.execute(parent, link.id, direct)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const other = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    await expect(
      endLink.execute(actor(other.id, ['TEACHER']), link.id, { reason: 'removed_by_teacher', message: 'x' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(endLink.execute(student, link.id, { reason: 'system', message: 'x' })).rejects.toMatchObject(
      {
        code: 'FORBIDDEN',
      },
    );
    expect((await links.findById(link.id))?.status).toBe('active');
  });

  it('a foreign parent cannot decide; a second request while one is pending is CONFLICT', async () => {
    const { student, link } = await setup();
    const requestId = requestIdOf(await leaves.request(student, link.id, 'причина'));
    expect(requestId).not.toBe('');
    await expect(leaves.request(student, link.id, 'снова')).rejects.toMatchObject({ code: 'CONFLICT' });
    const stranger = await createAccount(tdb.txm, { roles: ['PARENT'] });
    await expect(leaves.decide(actor(stranger.id, ['PARENT']), requestId, true, null)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect((await ctx.get(LeaveRequestRepository).findById(requestId))?.status).toBe('pending');
  });

  it('teacher ending the link and the parent deciding at once: no deadlock, one consistent outcome', async () => {
    const { teacher, student, parent, link } = await setup();
    const requestId = requestIdOf(await leaves.request(student, link.id, 'причина'));
    const results = await Promise.allSettled([
      endLink.execute(teacher, link.id, { reason: 'removed_by_teacher', message: 'пока' }),
      leaves.decide(parent, requestId, true, null),
    ]);
    for (const r of results) {
      if (r.status === 'rejected')
        expect((r.reason as { code?: string }).code).toMatch(/CONFLICT|LINK_NOT_ACTIVE/);
    }
    expect((await links.findById(link.id))?.status).toBe('ended');
    expect(['approved', 'cancelled']).toContain(
      (await ctx.get(LeaveRequestRepository).findById(requestId))?.status,
    );
  });

  it('ending the link with an open request cancels the 48-hour reminder; redelivered events do not duplicate', async () => {
    const { teacher, student, link, ids } = await setup();
    await leaves.request(student, link.id, 'причина');
    await drainOutbox(ctx, tdb);
    const before = await tdb.db
      .select()
      .from(notification)
      .where(eq(notification.typeCode, 'link.leave_reminder'));
    expect(before.filter((r) => r.recipientId === ids.p && r.status === 'scheduled')).toHaveLength(1);
    await endLink.execute(teacher, link.id, { reason: 'removed_by_teacher', message: 'пока' });
    await drainOutbox(ctx, tdb);
    const after = await tdb.db
      .select()
      .from(notification)
      .where(eq(notification.typeCode, 'link.leave_reminder'));
    expect(after.find((r) => r.recipientId === ids.p)?.status).toBe('cancelled');
    // redeliver the last event: dedupe keys keep the notification count unchanged
    const count = (await tdb.db.select().from(notification)).length;
    const last = (await tdb.db.select().from(outboxEvent).where(eq(outboxEvent.eventType, 'link.ended'))).at(
      -1,
    )!;
    await ctx.get(DomainEventBus).dispatch({
      id: last.id,
      type: last.eventType,
      aggregateType: last.aggregateType,
      aggregateId: last.aggregateId,
      payload: last.payload,
      createdAt: last.createdAt,
      correlationId: null,
    });
    expect((await tdb.db.select().from(notification)).length).toBe(count);
  });

  it('expiry and a late decision: whichever runs first wins, the other gets CONFLICT', async () => {
    const { student, parent, link } = await setup();
    const requestId = requestIdOf(await leaves.request(student, link.id, 'причина'));
    ctx.clock.advance(8 * DAY_MS);
    try {
      expect(await leaves.expireOverdue()).toBeGreaterThanOrEqual(1); // earlier tests may have left pending requests
    } finally {
      ctx.clock.advance(-8 * DAY_MS);
    }
    await expect(leaves.decide(parent, requestId, true, null)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await links.findById(link.id))?.status).toBe('active');
  });
});
