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
import { TeacherSettingsUseCase } from '@modules/people/teacher-settings.use-case.js';
import { BotApiModule } from '@telegram/api/bot-api.module.js';
import { BlockAccountUseCase } from '@modules/identity/block-account.use-case.js';
import { OpenSlotsQuery } from '../availability/open-slots.query.js';
import { AvailabilityUseCase } from '../availability/availability.use-case.js';
import { CreateLessonUseCase } from '../lessons/create-lesson.use-case.js';
import { LessonRepository } from '../lessons/lesson.repository.js';
import { BookingRequestRepository } from '../requests/booking-request.repository.js';
import { RescheduleRequestUseCase } from '../reschedule/reschedule-request.use-case.js';
import { ScheduleModule } from '../schedule.module.js';
import { BookSlotUseCase } from './book-slot.use-case.js';

const actor = (id: string, role: 'TEACHER' | 'STUDENT' | 'ADMIN'): Actor => ({
  accountId: id,
  roles: [role],
  status: 'active',
  source: 'bot',
});
const utc = (iso: string) => new Date(iso);

describe('UC-16 / UC-17: self-booking in both modes (5.5.5, PPL-06, CAL-10)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let book: BookSlotUseCase;
  let requests: RescheduleRequestUseCase;
  let lessons: LessonRepository;
  let annaId: string;
  let petyaId: string;
  let mashaId: string;
  const anna = () => actor(annaId, 'TEACHER');
  const petya = () => actor(petyaId, 'STUDENT');
  const masha = () => actor(mashaId, 'STUDENT');
  const notes = (recipientId: string, type: string) =>
    tdb.db
      .select()
      .from(notification)
      .where(and(eq(notification.recipientId, recipientId), eq(notification.typeCode, type)));

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [
      PeopleModule,
      AccessModule,
      ScheduleModule,
      BotApiModule,
      NotificationsModule,
    ]);
    book = ctx.get(BookSlotUseCase);
    requests = ctx.get(RescheduleRequestUseCase);
    lessons = ctx.get(LessonRepository);
    annaId = (
      await createAccount(tdb.txm, {
        roles: ['TEACHER'],
        firstName: 'Анна',
        lastName: 'П',
        timezone: 'Europe/Minsk',
      })
    ).id;
    await ctx
      .get(TeacherProfileRepository)
      .upsert(annaId, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now(), calendarMode: 'open_all' });
    petyaId = (
      await createAccount(tdb.txm, {
        roles: ['STUDENT'],
        firstName: 'Петя',
        lastName: 'И',
        timezone: 'Europe/Minsk',
      })
    ).id;
    mashaId = (
      await createAccount(tdb.txm, {
        roles: ['STUDENT'],
        firstName: 'Маша',
        lastName: 'С',
        timezone: 'Europe/Minsk',
      })
    ).id;
    await linkStudent(ctx, annaId, petyaId, { maxLessonsPerWeek: 2 });
    await linkStudent(ctx, annaId, mashaId, { maxLessonsPerWeek: null });
    const admin = await createAccount(tdb.txm, { roles: ['ADMIN'] });
    await ctx
      .get(FeatureAdminUseCase)
      .setTeacher(actor(admin.id, 'ADMIN'), annaId, 'calendar.open_booking', { enabled: true });
    await ctx
      .get(AvailabilityUseCase)
      .addRule(anna(), { weekdays: [1, 2, 3, 4, 5, 6, 7], startMin: 600, endMin: 1080 });
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('auto mode: the lesson is created at once, the teacher gets «записался ученик» with OK / Cancel; a taken slot; PPL-06', async () => {
    ctx.clock.set('2026-10-19T12:00:00Z');
    const result = await book.book(petya(), {
      teacherId: annaId,
      startsAt: utc('2026-10-20T08:00:00Z'),
      durationMin: 60,
      comment: 'Хочу разобрать дроби',
    });
    expect(result.kind).toBe('lesson');
    const lesson = result.kind === 'lesson' ? result.lesson : null;
    expect(lesson).toMatchObject({
      createdVia: 'student_booking',
      createdBy: petyaId,
      teacherNotes: 'Хочу разобрать дроби',
      seqNo: 1,
    });
    await drainOutbox(ctx, tdb);
    const toAnna = await notes(annaId, 'lesson.created');
    expect(toAnna).toHaveLength(1);
    expect(toAnna[0]!.payload).toMatchObject({ view: 'booked', student: 'Петя И', when: 'вт 20.10 11:00' });
    expect(toAnna[0]!.payload['buttons']).toEqual([
      { text: '👌 ОК', data: `s:today:lesson:${lesson!.id}` },
      { text: '❌ Отменить', data: `s:today:cancel:${lesson!.id}` },
    ]);
    expect(await notes(petyaId, 'lesson.created')).toHaveLength(0); // the booking itself confirms it
    expect((await notes(petyaId, 'lesson.reminder')).length).toBeGreaterThan(0);
    // 2а: Masha wants the same slot → it is no longer open
    await expect(
      book.book(masha(), { teacherId: annaId, startsAt: utc('2026-10-20T08:00:00Z'), durationMin: 60 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { reason: 'not_open' } });
    // outside the windows; a duration the teacher does not offer
    await expect(
      book.book(masha(), { teacherId: annaId, startsAt: utc('2026-10-20T05:00:00Z'), durationMin: 60 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      book.book(masha(), { teacherId: annaId, startsAt: utc('2026-10-20T10:00:00Z'), durationMin: 45 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    // PPL-06: Petya's limit is 2 per week (Mon–Sun, Minsk)
    await book.book(petya(), { teacherId: annaId, startsAt: utc('2026-10-21T08:00:00Z'), durationMin: 60 });
    await expect(
      book.book(petya(), { teacherId: annaId, startsAt: utc('2026-10-22T08:00:00Z'), durationMin: 60 }),
    ).rejects.toMatchObject({ code: 'WEEKLY_LIMIT_EXCEEDED', details: { limit: 2, count: 2 } });
    const nextWeek = await book.book(petya(), {
      teacherId: annaId,
      startsAt: utc('2026-10-26T08:00:00Z'),
      durationMin: 60,
    });
    expect(nextWeek.kind).toBe('lesson');
    expect((await book.openTeachers(petya())).map((l) => l.teacherId)).toEqual([annaId]);
  });

  it('CAL-10: two concurrent bookings of one slot — exactly one lesson, the other loses the race', async () => {
    const startsAt = utc('2026-10-23T08:00:00Z');
    const [a, b] = await Promise.allSettled([
      book.book(masha(), { teacherId: annaId, startsAt, durationMin: 60 }),
      book.book(masha(), { teacherId: annaId, startsAt: utc('2026-10-23T08:30:00Z'), durationMin: 60 }),
    ]);
    const outcomes = [a, b].map((r) =>
      r.status === 'fulfilled' ? 'ok' : (r.reason as { code: string }).code,
    );
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    expect(outcomes.some((o) => o === 'LESSON_CONFLICT' || o === 'VALIDATION_ERROR')).toBe(true);
    const rows = await lessons.listByTeacher(annaId, { start: startsAt, end: utc('2026-10-23T10:00:00Z') }, [
      'scheduled',
    ]);
    expect(rows).toHaveLength(1);
  });

  it('manual mode, CAL-10: two parallel requests with max 1 per slot → exactly one pending; a pending reschedule request does not count', async () => {
    ctx.clock.set('2026-10-19T12:00:00Z');
    await ctx
      .get(TeacherSettingsUseCase)
      .update(anna(), { bookingConfirmation: 'manual', bookingRules: { maxPendingPerSlot: 1 } });
    const olya = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Оля', lastName: 'К' })).id;
    await linkStudent(ctx, annaId, olya, { maxLessonsPerWeek: null });
    // Masha's pending *reschedule* request over 11:00 must not take the only booking slot
    const { lesson } = await ctx.get(CreateLessonUseCase).execute(anna(), {
      target: { studentId: mashaId },
      startsAt: utc('2026-11-02T13:00:00Z'),
      durationMin: 60,
    });
    await requests.request(masha(), {
      lessonId: lesson.id,
      startsAt: utc('2026-11-03T08:00:00Z'),
      reason: 'перенос',
    });
    const slot = utc('2026-11-03T08:00:00Z');
    const outcomes = (
      await Promise.allSettled([
        book.book(petya(), { teacherId: annaId, startsAt: slot, durationMin: 60 }),
        book.book(actor(olya, 'STUDENT'), { teacherId: annaId, startsAt: slot, durationMin: 60 }),
      ])
    ).map((r) => (r.status === 'fulfilled' ? 'ok' : (r.reason as { code: string }).code));
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    // the loser either hit the limit under the lock or saw the slot already hidden as full (M-5)
    expect(outcomes.some((o) => o === 'SLOT_REQUESTS_FULL' || o === 'VALIDATION_ERROR')).toBe(true);
    const pending = await ctx
      .get(BookingRequestRepository)
      .lockPendingOverlapping(annaId, slot, utc('2026-11-03T09:00:00Z'));
    expect(pending.map((r) => r.kind).sort()).toEqual(['booking', 'reschedule']);
    await ctx
      .get(TeacherSettingsUseCase)
      .update(anna(), { bookingConfirmation: 'auto', bookingRules: { maxPendingPerSlot: 2 } });
  });

  it('manual mode: a request holds nothing, at most N per slot; accept creates the lesson and declines the overlapping ones', async () => {
    ctx.clock.set('2026-10-19T12:00:00Z');
    const settings = ctx.get(TeacherSettingsUseCase);
    await settings.update(anna(), { bookingConfirmation: 'manual', bookingRules: { maxPendingPerSlot: 2 } });
    const slot = utc('2026-10-28T08:00:00Z');
    const r1 = await book.book(petya(), {
      teacherId: annaId,
      startsAt: slot,
      durationMin: 60,
      comment: 'Петя',
    });
    expect(r1.kind).toBe('request');
    const first = r1.kind === 'request' ? r1.request : null;
    expect(first).toMatchObject({ kind: 'booking', status: 'pending', lessonId: null, comment: 'Петя' });
    // the slot stays open (Р-22): Masha asks for it too; the third request hits the limit (1в)
    const r2 = await book.book(masha(), {
      teacherId: annaId,
      startsAt: utc('2026-10-28T08:30:00Z'),
      durationMin: 60,
    });
    expect(r2.kind).toBe('request');
    const olga = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Оля' })).id;
    await linkStudent(ctx, annaId, olga, { maxLessonsPerWeek: null });
    await expect(
      book.book(actor(olga, 'STUDENT'), { teacherId: annaId, startsAt: slot, durationMin: 60 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { reason: 'not_open' } }); // 1в: the full slot is hidden (M-5)
    await expect(
      book.book(petya(), { teacherId: annaId, startsAt: slot, durationMin: 60 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' }); // the same student: the full slot is hidden too
    await drainOutbox(ctx, tdb);
    const asked = (await notes(annaId, 'booking.requested')).filter(
      (n) => n.payload['view'] === 'booking' && String(n.payload['when']).startsWith('ср 28.10'),
    );
    expect(asked).toHaveLength(2);
    expect(
      asked.some((n) => n.payload['student'] === 'Петя И' && n.payload['when'] === 'ср 28.10 11:00'),
    ).toBe(true);
    const mine = (await requests.pendingForTeacher(anna())).filter(
      (v) => v.request.startsAt! >= slot && v.request.startsAt! < utc('2026-10-29T00:00:00Z'),
    );
    expect(mine.map((v) => v.request.kind)).toEqual(['booking', 'booking']);
    const r3result = await book.book(petya(), {
      teacherId: annaId,
      startsAt: utc('2026-10-29T08:00:00Z'),
      durationMin: 60,
    });
    const r3 = r3result.kind === 'request' ? r3result.request : null!;
    // accept Petya's: the lesson is created (booking_accepted), Masha's overlapping request is declined as slot_taken
    const accepted = await requests.decide(anna(), { requestId: first!.id, accept: true });
    expect(accepted).toMatchObject({ status: 'accepted', decisionReason: 'accepted' });
    const created = await lessons.listByTeacher(annaId, { start: slot, end: utc('2026-10-28T09:00:00Z') }, [
      'scheduled',
    ]);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      createdVia: 'booking_accepted',
      createdBy: petyaId,
      teacherNotes: 'Петя',
    });
    const second = r2.kind === 'request' ? r2.request : null;
    expect((await ctx.get(BookingRequestRepository).findById(second!.id))!).toMatchObject({
      status: 'declined',
      decisionReason: 'slot_taken',
    });
    await drainOutbox(ctx, tdb);
    const petyaDecided = (await notes(petyaId, 'booking.decided')).filter((n) =>
      n.dedupeKey.includes(first!.id),
    );
    expect(petyaDecided[0]!.payload).toMatchObject({
      view: 'accepted',
      kind: 'booking',
      when: 'ср 28.10 11:00',
    });
    const mashaDecided = (await notes(mashaId, 'booking.decided')).filter((n) =>
      n.dedupeKey.includes(second!.id),
    );
    expect(mashaDecided[0]!.payload).toMatchObject({ view: 'slot_taken', kind: 'booking' });
    expect(String(mashaDecided[0]!.payload['slots'])).toContain('вт 20.10');
    expect((await notes(annaId, 'lesson.created')).some((n) => n.dedupeKey.includes(created[0]!.id))).toBe(
      false,
    ); // accepted by the teacher: no «записался»
    // the weekly limit is checked at accept time too: r3 was asked while Petya had one lesson that week
    expect(await requests.decide(anna(), { requestId: r3.id, accept: true })).toMatchObject({
      status: 'declined',
      decisionReason: 'weekly_limit',
    });
    await ctx.get(TeacherSettingsUseCase).update(anna(), { bookingConfirmation: 'auto' });
  });

  it('M-5 / H-2: slots with N pending requests are hidden in the confirmation mode; a blocked teacher is unbookable', async () => {
    ctx.clock.set('2026-10-19T12:00:00Z');
    await ctx
      .get(TeacherSettingsUseCase)
      .update(anna(), { bookingConfirmation: 'manual', bookingRules: { maxPendingPerSlot: 1 } });
    const slot = utc('2026-11-04T08:00:00Z');
    const r = await book.book(masha(), { teacherId: annaId, startsAt: slot, durationMin: 60 });
    expect(r.kind).toBe('request');
    const { slots } = await ctx.get(OpenSlotsQuery).slots(petya(), {
      teacherId: annaId,
      range: { start: utc('2026-11-04T00:00:00Z'), end: utc('2026-11-05T00:00:00Z') },
    });
    expect(slots.some((s) => s.start.getTime() === slot.getTime())).toBe(false); // full
    expect(slots.some((s) => s.start.getTime() === utc('2026-11-04T09:30:00Z').getTime())).toBe(true); // 30 min later is free of overlap? no: 09:00–10:00 overlaps 08:30? it does not overlap 08:00–09:00
    await ctx
      .get(TeacherSettingsUseCase)
      .update(anna(), { bookingConfirmation: 'auto', bookingRules: { maxPendingPerSlot: 2 } });
    const admin = (await createAccount(tdb.txm, { roles: ['ADMIN'] })).id;
    await ctx
      .get(BlockAccountUseCase)
      .block(actor(admin, 'ADMIN'), annaId, { reason: 'x', lessonsPolicy: 'keep' });
    expect(await book.openTeachers(petya())).toEqual([]);
    await expect(
      book.book(petya(), { teacherId: annaId, startsAt: utc('2026-11-05T08:00:00Z'), durationMin: 60 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      ctx.get(OpenSlotsQuery).slots(petya(), {
        teacherId: annaId,
        range: { start: utc('2026-11-05T00:00:00Z'), end: utc('2026-11-06T00:00:00Z') },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
