import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount } from '@test/factories.js';
import { drainOutbox } from '@test/outbox.js';
import { linkStudent, MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import type { Actor } from '@modules/access/actor.js';
import { FeatureAdminUseCase } from '@modules/access/features/feature-admin.use-case.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { notification } from '@modules/notifications/schema.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { BotApiModule } from '@telegram/api/bot-api.module.js';
import { AvailabilityUseCase } from '../availability/availability.use-case.js';
import { CreateLessonUseCase } from '../lessons/create-lesson.use-case.js';
import { LessonRepository } from '../lessons/lesson.repository.js';
import { BookingRequestRepository } from '../requests/booking-request.repository.js';
import { occupancy } from '../schema.js';
import { ScheduleModule } from '../schedule.module.js';
import { RescheduleLessonUseCase } from './reschedule-lesson.use-case.js';
import { RescheduleRequestUseCase } from './reschedule-request.use-case.js';

const actor = (id: string, role: 'TEACHER' | 'STUDENT' | 'PARENT' | 'ADMIN'): Actor => ({
  accountId: id,
  roles: [role],
  status: 'active',
  source: 'bot',
});
const utc = (iso: string) => new Date(iso);

describe('UC-18 / UC-19: rescheduling (5.7.4) and reschedule requests (M4-03)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let move: RescheduleLessonUseCase;
  let requests: RescheduleRequestUseCase;
  let create: CreateLessonUseCase;
  let lessons: LessonRepository;
  let annaId: string;
  let petyaId: string;
  let mashaId: string;
  const anna = () => actor(annaId, 'TEACHER');
  const petya = () => actor(petyaId, 'STUDENT');

  const notes = (recipientId: string, type: string) =>
    tdb.db
      .select()
      .from(notification)
      .where(and(eq(notification.recipientId, recipientId), eq(notification.typeCode, type)));
  const busyOf = (lessonId: string) =>
    tdb.db
      .select()
      .from(occupancy)
      .where(and(eq(occupancy.lessonId, lessonId), eq(occupancy.isActive, true)));
  const lessonAt = (startIso: string, studentId = petyaId) =>
    create.execute(anna(), { target: { studentId }, startsAt: utc(startIso), durationMin: 60 });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [
      PeopleModule,
      AccessModule,
      ScheduleModule,
      BotApiModule,
      NotificationsModule,
    ]);
    move = ctx.get(RescheduleLessonUseCase);
    requests = ctx.get(RescheduleRequestUseCase);
    create = ctx.get(CreateLessonUseCase);
    lessons = ctx.get(LessonRepository);
    annaId = (
      await createAccount(tdb.txm, {
        roles: ['TEACHER'],
        firstName: 'Анна',
        lastName: 'П',
        timezone: 'Europe/Minsk',
      })
    ).id;
    await ctx.get(TeacherProfileRepository).upsert(annaId, {
      subjectIds: [MATH_ID],
      onboardedAt: ctx.clock.now(),
      defaultNoticeText: 'Вынуждена перенести занятие',
      calendarMode: 'open_all',
    });
    petyaId = (
      await createAccount(tdb.txm, {
        roles: ['STUDENT'],
        firstName: 'Петя',
        lastName: 'И',
        timezone: 'Europe/Minsk',
      })
    ).id;
    mashaId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Маша', lastName: 'С' })).id;
    await linkStudent(ctx, annaId, petyaId, { maxLessonsPerWeek: null });
    await linkStudent(ctx, annaId, mashaId, { maxLessonsPerWeek: null });
    const admin = await createAccount(tdb.txm, { roles: ['ADMIN'] });
    await ctx
      .get(FeatureAdminUseCase)
      .setTeacher(actor(admin.id, 'ADMIN'), annaId, 'calendar.open_booking', { enabled: true });
    // windows every day 10:00–18:00 Minsk → open slots for requests
    await ctx
      .get(AvailabilityUseCase)
      .addRule(anna(), { weekdays: [1, 2, 3, 4, 5, 6, 7], startMin: 600, endMin: 1080 });
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('UC-18: the teacher moves a lesson — occupancy re-reserved, version grows, history, notice with buttons, reminders re-planned; a conflict rolls back', async () => {
    ctx.clock.set('2026-10-19T12:00:00Z');
    const { lesson } = await lessonAt('2026-10-22T13:00:00Z');
    await drainOutbox(ctx, tdb); // reminders of version 1
    const blocker = await lessonAt('2026-10-23T13:00:00Z', mashaId);
    // the new time collides with Masha's lesson → LESSON_CONFLICT, nothing changes (old time stays reserved)
    await expect(
      move.execute(anna(), { lessonId: lesson.id, startsAt: utc('2026-10-23T13:30:00Z') }),
    ).rejects.toMatchObject({ code: 'LESSON_CONFLICT', details: { who: 'teacher' } });
    const stale = (await lessons.findById(lesson.id))!;
    expect(stale.startsAt).toEqual(utc('2026-10-22T13:00:00Z'));
    expect((await busyOf(lesson.id)).length).toBe(2);
    await expect(
      move.execute(anna(), { lessonId: lesson.id, startsAt: utc('2026-10-22T13:00:00Z') }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { reason: 'same_time' } });
    const moved = await move.execute(anna(), { lessonId: lesson.id, startsAt: utc('2026-10-24T09:00:00Z') });
    expect(moved).toMatchObject({
      startsAt: utc('2026-10-24T09:00:00Z'),
      endsAt: utc('2026-10-24T10:00:00Z'),
      version: 2,
    });
    const busy = await busyOf(lesson.id);
    expect(busy.length).toBe(2);
    expect(busy.every((o) => o.during.start.getTime() === utc('2026-10-24T09:00:00Z').getTime())).toBe(true);
    const events = await lessons.listEvents(lesson.id);
    expect(events.at(-1)).toMatchObject({ type: 'rescheduled' });
    expect(events.at(-1)!.payload).toMatchObject({
      from: { startsAt: '2026-10-22T13:00:00.000Z' },
      to: { startsAt: '2026-10-24T09:00:00.000Z' },
      comment: 'Вынуждена перенести занятие', // Р-8: the default text when the comment is empty
    });
    await drainOutbox(ctx, tdb);
    const notice = await notes(petyaId, 'lesson.rescheduled');
    expect(notice).toHaveLength(1);
    expect(notice[0]!.payload).toMatchObject({
      from: 'чт 22.10 16:00',
      to: 'сб 24.10 12:00',
      comment: 'Вынуждена перенести занятие',
    });
    expect(notice[0]!.payload['buttons']).toEqual([
      { text: '👌 ОК', data: `s:schedule:rok:${lesson.id}` },
      { text: '🙅 Не могу в это время', data: `s:schedule:rno:${lesson.id}` },
    ]);
    const reminders = (await notes(petyaId, 'lesson.reminder')).filter((n) =>
      n.dedupeKey.includes(lesson.id),
    );
    expect(reminders.filter((n) => n.status === 'cancelled').length).toBeGreaterThan(0); // NTF-05: old ones dropped
    expect(reminders.some((n) => n.status === 'scheduled' && n.dedupeKey.includes(':2:'))).toBe(true); // new version
    // «Не могу в это время» → the teacher is told; «ОК» is history only
    await move.object(petya(), { lessonId: lesson.id, reason: 'В субботу тренировка' });
    await move.acknowledge(petya(), lesson.id);
    await expect(
      move.object(actor(mashaId, 'STUDENT'), { lessonId: lesson.id, reason: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await drainOutbox(ctx, tdb);
    const objection = await notes(annaId, 'lesson.reschedule_objection');
    expect(objection).toHaveLength(1);
    expect(objection[0]!.payload).toMatchObject({
      view: 'by-student',
      student: 'Петя И',
      reason: 'В субботу тренировка',
    });
    expect((await lessons.listEvents(lesson.id)).map((e) => e.type).slice(-2)).toEqual([
      'reschedule_objection',
      'reschedule_ack',
    ]);
    expect((await lessons.findById(blocker.lesson.id))!.status).toBe('scheduled');
  });

  it('UC-19: request with an open calendar → accepted (move + decision), slot taken → declined with open slots, decline with a message, expiry', async () => {
    ctx.clock.set('2026-10-19T12:00:00Z');
    const { lesson } = await lessonAt('2026-10-26T13:00:00Z');
    expect(await requests.mode(petya(), lesson.id)).toBe('request');
    // only an open slot is accepted; a pending request is single per lesson and student
    await expect(
      requests.request(petya(), {
        lessonId: lesson.id,
        startsAt: utc('2026-10-27T05:00:00Z'),
        reason: 'Олимпиада',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { reason: 'not_open' } });
    await expect(
      requests.request(petya(), { lessonId: lesson.id, startsAt: utc('2026-10-27T08:00:00Z'), reason: ' ' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const row = await requests.request(petya(), {
      lessonId: lesson.id,
      startsAt: utc('2026-10-27T08:00:00Z'),
      reason: 'Олимпиада',
    });
    expect(row).toMatchObject({
      kind: 'reschedule',
      status: 'pending',
      lessonId: lesson.id,
      comment: 'Олимпиада',
    });
    expect(row.endsAt).toEqual(utc('2026-10-27T09:00:00Z'));
    expect((await busyOf(lesson.id))[0]!.during.start).toEqual(utc('2026-10-26T13:00:00Z')); // nothing held (Р-24)
    await expect(
      requests.request(petya(), {
        lessonId: lesson.id,
        startsAt: utc('2026-10-28T08:00:00Z'),
        reason: 'ещё',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'pending_exists' } });
    await drainOutbox(ctx, tdb);
    const asked = await notes(annaId, 'booking.requested');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.payload).toMatchObject({
      view: 'reschedule',
      student: 'Петя И',
      when: 'вт 27.10 11:00',
      comment: 'Олимпиада',
    });
    expect(asked[0]!.payload['buttons']).toEqual([
      { text: '✅ Подтвердить', data: `s:today:rq:${row.id}:ok` },
      { text: '❌ Отклонить', data: `s:today:rq:${row.id}:no` },
    ]);
    expect((await requests.pendingForTeacher(anna())).map((v) => v.request.id)).toEqual([row.id]);
    await expect(requests.decide(anna(), { requestId: row.id, accept: false })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    const accepted = await requests.decide(anna(), { requestId: row.id, accept: true });
    expect(accepted).toMatchObject({ status: 'accepted', decisionReason: 'accepted' });
    expect((await lessons.findById(lesson.id))!.startsAt).toEqual(utc('2026-10-27T08:00:00Z'));
    await drainOutbox(ctx, tdb);
    const decided = await notes(petyaId, 'booking.decided');
    expect(decided).toHaveLength(1);
    expect(decided[0]!.payload).toMatchObject({ view: 'accepted', when: 'вт 27.10 11:00' });
    expect(
      (await notes(petyaId, 'lesson.rescheduled')).filter((n) => n.dedupeKey.includes(lesson.id)),
    ).toHaveLength(0); // the decision, not the move notice
    await expect(requests.decide(anna(), { requestId: row.id, accept: true })).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    // slot taken: the teacher places another lesson there before accepting → declined with open slots
    const second = await requests.request(petya(), {
      lessonId: lesson.id,
      startsAt: utc('2026-10-29T08:00:00Z'),
      reason: 'Снова',
    });
    await lessonAt('2026-10-29T08:00:00Z', mashaId);
    const taken = await requests.decide(anna(), { requestId: second.id, accept: true });
    expect(taken).toMatchObject({ status: 'declined', decisionReason: 'slot_taken' });
    expect((await lessons.findById(lesson.id))!.startsAt).toEqual(utc('2026-10-27T08:00:00Z'));
    await drainOutbox(ctx, tdb);
    const slotTaken = (await notes(petyaId, 'booking.decided')).find((n) =>
      n.dedupeKey.startsWith(`booking.decided:${second.id}`),
    )!;
    expect(slotTaken.payload).toMatchObject({ view: 'slot_taken' });
    expect(String(slotTaken.payload['slots'])).toContain('вт 20.10 10:00'); // the next open slots

    // decline with a message; expiry once the slot is closer than the minimum notice (12 h)
    const third = await requests.request(petya(), {
      lessonId: lesson.id,
      startsAt: utc('2026-10-30T08:00:00Z'),
      reason: 'Третий',
    });
    const declined = await requests.decide(anna(), {
      requestId: third.id,
      accept: false,
      message: 'Не получится',
    });
    expect(declined).toMatchObject({ status: 'declined', decisionMessage: 'Не получится' });
    const fourth = await requests.request(petya(), {
      lessonId: lesson.id,
      startsAt: utc('2026-10-31T08:00:00Z'),
      reason: 'Четвёртый',
    });
    expect(await requests.expire()).toBe(0);
    ctx.clock.set('2026-10-30T21:00:00Z'); // 11 h before the wanted slot
    expect(await requests.expire()).toBe(1);
    expect((await ctx.get(BookingRequestRepository).findById(fourth.id))!.status).toBe('expired');
    await drainOutbox(ctx, tdb);
    expect((await notes(petyaId, 'booking.decided')).some((n) => n.payload['view'] === 'expired')).toBe(true);
    ctx.clock.set('2026-10-19T12:00:00Z');
  });

  it('decide edge cases: a cancelled lesson closes the request, a slot in the past expires it, a plea is acknowledged, an objection is single', async () => {
    ctx.clock.set('2026-10-19T12:00:00Z');
    const a = await lessonAt('2026-11-02T13:00:00Z');
    const r1 = await requests.request(petya(), {
      lessonId: a.lesson.id,
      startsAt: utc('2026-11-03T08:00:00Z'),
      reason: 'r1',
    });
    await lessons.update(a.lesson.id, { status: 'cancelled', cancelledAt: ctx.clock.now() });
    const gone = await requests.decide(anna(), { requestId: r1.id, accept: true });
    expect(gone).toMatchObject({ status: 'cancelled', decisionReason: 'lesson_changed' });
    const b = await lessonAt('2026-11-04T13:00:00Z');
    const r2 = await requests.request(petya(), {
      lessonId: b.lesson.id,
      startsAt: utc('2026-11-05T08:00:00Z'),
      reason: 'r2',
    });
    ctx.clock.set('2026-11-05T08:30:00Z'); // the wanted slot has started
    const late = await requests.decide(anna(), { requestId: r2.id, accept: true });
    expect(late).toMatchObject({ status: 'expired', decisionReason: 'expired' });
    expect((await lessons.findById(b.lesson.id))!.startsAt).toEqual(utc('2026-11-04T13:00:00Z'));
    ctx.clock.set('2026-10-19T12:00:00Z');
    const c = await lessonAt('2026-11-06T13:00:00Z');
    const plea = await requests.ask(petya(), { lessonId: c.lesson.id, reason: 'Пораньше' });
    const ack = await requests.decide(anna(), { requestId: plea.id, accept: true });
    expect(ack).toMatchObject({ status: 'accepted', decisionReason: 'acknowledged' });
    await drainOutbox(ctx, tdb);
    expect((await notes(petyaId, 'booking.decided')).some((n) => n.payload['view'] === 'acknowledged')).toBe(
      true,
    );
    await move.execute(anna(), { lessonId: c.lesson.id, startsAt: utc('2026-11-06T15:00:00Z') });
    await move.object(petya(), { lessonId: c.lesson.id, reason: 'Нет' });
    await expect(move.object(petya(), { lessonId: c.lesson.id, reason: 'Опять' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('closed calendar → a plea; moving the lesson by hand closes it; a stranger gets NOT_FOUND', async () => {
    await ctx.get(TeacherProfileRepository).upsert(annaId, { calendarMode: 'closed' });
    const { lesson } = await lessonAt('2026-11-03T13:00:00Z');
    expect(await requests.mode(petya(), lesson.id)).toBe('ask');
    await expect(
      requests.request(petya(), { lessonId: lesson.id, startsAt: utc('2026-11-04T08:00:00Z'), reason: 'x' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const plea = await requests.ask(petya(), { lessonId: lesson.id, reason: 'Не успеваю после школы' });
    expect(plea).toMatchObject({ kind: 'reschedule_ask', startsAt: null, status: 'pending' });
    await expect(
      requests.ask(actor(mashaId, 'STUDENT'), { lessonId: lesson.id, reason: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await drainOutbox(ctx, tdb);
    const asked = (await notes(annaId, 'booking.requested')).filter((n) => n.dedupeKey.includes(plea.id));
    expect(asked[0]!.payload).toMatchObject({ view: 'reschedule_ask', comment: 'Не успеваю после школы' });
    await move.execute(anna(), {
      lessonId: lesson.id,
      startsAt: utc('2026-11-03T15:00:00Z'),
      comment: 'Перенесла позже',
    });
    expect((await ctx.get(BookingRequestRepository).findById(plea.id))!).toMatchObject({
      status: 'cancelled',
      decisionReason: 'lesson_changed',
    });
    await drainOutbox(ctx, tdb);
    expect(
      (await notes(petyaId, 'booking.decided')).some((n) => n.payload['view'] === 'lesson_changed'),
    ).toBe(true);
    expect((await notes(petyaId, 'lesson.rescheduled')).some((n) => n.dedupeKey.includes(lesson.id))).toBe(
      true,
    );
    await ctx.get(TeacherProfileRepository).upsert(annaId, { calendarMode: 'open_all' });
  });

  it('M-2 / M-4: a request may shift the lesson inside its own time; the move notice is urgent by the sooner time', async () => {
    ctx.clock.set('2026-10-19T12:00:00Z');
    const { lesson } = await lessonAt('2026-10-21T08:00:00Z'); // 11:00–12:00 Minsk, inside the windows
    const shifted = await requests.request(petya(), {
      lessonId: lesson.id,
      startsAt: utc('2026-10-21T08:30:00Z'),
      reason: 'На полчаса позже',
    });
    expect(shifted.startsAt).toEqual(utc('2026-10-21T08:30:00Z'));
    await requests.decide(anna(), { requestId: shifted.id, accept: true });
    expect((await lessons.findById(lesson.id))!.startsAt).toEqual(utc('2026-10-21T08:30:00Z'));
    // a lesson tomorrow morning moved to next month late in the evening: delivered at once, not after quiet hours
    ctx.clock.set('2026-10-21T20:30:00Z'); // 23:30 Minsk
    const soon = await lessonAt('2026-10-22T04:30:00Z'); // 07:30 Minsk tomorrow
    await move.execute(anna(), { lessonId: soon.lesson.id, startsAt: utc('2026-11-20T08:00:00Z') });
    await drainOutbox(ctx, tdb);
    const notice = (await notes(petyaId, 'lesson.rescheduled')).find((n) =>
      n.dedupeKey.includes(soon.lesson.id),
    )!;
    expect(notice.dueAt).toEqual(utc('2026-10-21T20:30:00Z'));
    ctx.clock.set('2026-10-19T12:00:00Z');
  });
});
