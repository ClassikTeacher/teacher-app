import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount } from '@test/factories.js';
import { FakeGoogleApi, GOOGLE_TEST_ENV } from '@test/google.js';
import { drainOutbox } from '@test/outbox.js';
import { linkStudent, MATH_ID } from '@test/people.js';
import { HOUR_MS } from '@shared/time/clock.js';
import { AccessModule } from '@modules/access/access.module.js';
import type { Actor } from '@modules/access/actor.js';
import { FeatureAdminUseCase } from '@modules/access/features/feature-admin.use-case.js';
import { notification } from '@modules/notifications/schema.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { AvailabilityUseCase } from '@modules/schedule/availability/availability.use-case.js';
import { OpenSlotsQuery } from '@modules/schedule/availability/open-slots.query.js';
import { CancelLessonUseCase } from '@modules/schedule/cancellations/cancel-lesson.use-case.js';
import { DayViewQuery } from '@modules/schedule/day-view.query.js';
import { CreateLessonUseCase } from '@modules/schedule/lessons/create-lesson.use-case.js';
import { BusyQuery } from '@modules/schedule/occupancy/busy.query.js';
import { RescheduleLessonUseCase } from '@modules/schedule/reschedule/reschedule-lesson.use-case.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { externalBusy } from '@modules/schedule/schema.js';
import { IntegrationsModule } from '../integrations.module.js';
import { googleCalendarConnection, googleCalendarEvent } from '../schema.js';
import { GOOGLE_API } from './google-api.js';
import { GoogleCalendarRepository } from './google-calendar.repository.js';
import { APP_CALENDAR_NAME, GoogleCalendarUseCase } from './google-calendar.use-case.js';
import { GoogleSyncJob } from './google-sync.job.js';
import { GoogleSyncService } from './google-sync.service.js';

const MON = '2026-11-09'; // the clock starts on Wed 2026-11-04
const busyOnMonday = { start: new Date(`${MON}T12:00:00Z`), end: new Date(`${MON}T13:00:00Z`) };

describe('E2-05 Google Calendar (5.14.1): OAuth, export of lessons, import of busy time, failures, disconnect', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let google: FakeGoogleApi;
  let useCase: GoogleCalendarUseCase;
  let job: GoogleSyncJob;
  let repo: GoogleCalendarRepository;
  let teacherId: string;
  let petyaId: string;
  let adminId: string;
  const actor = (id: string, role: Actor['roles'][number]): Actor => ({
    accountId: id,
    roles: [role],
    status: 'active',
    source: 'bot',
  });
  const teacher = () => actor(teacherId, 'TEACHER');
  const stateOf = (url: string): string => new URL(url).searchParams.get('state')!;
  const connection = async () => (await repo.findLive(teacherId))!;
  const busyRows = () => tdb.db.select().from(externalBusy).where(eq(externalBusy.accountId, teacherId));
  const notificationsOf = (type: string) =>
    tdb.db.select().from(notification).where(eq(notification.typeCode, type));
  const calendarId = async () => (await connection()).calendarId!;

  async function connect(code: string, email = 'anna@gmail.com'): Promise<string> {
    const url = await useCase.connectUrl(teacher());
    google.codes.set(code, { email });
    await useCase.completeOAuth(stateOf(url), code);
    return calendarId();
  }

  beforeAll(async () => {
    tdb = await createTestDatabase();
    google = new FakeGoogleApi();
    ctx = await createTestContext(
      tdb,
      [AccessModule, PeopleModule, ScheduleModule, NotificationsModule, IntegrationsModule],
      {
        now: '2026-11-04T10:00:00Z',
        env: GOOGLE_TEST_ENV,
        overrides: [{ token: GOOGLE_API, value: google }],
      },
    );
    useCase = ctx.get(GoogleCalendarUseCase);
    job = ctx.get(GoogleSyncJob);
    repo = ctx.get(GoogleCalendarRepository);
    teacherId = (await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Анна', lastName: 'Петрова' }))
      .id;
    await ctx
      .get(TeacherProfileRepository)
      .upsert(teacherId, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now(), calendarMode: 'open_all' });
    petyaId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Петя', lastName: 'Иванов' }))
      .id;
    adminId = (await createAccount(tdb.txm, { roles: ['ADMIN'] })).id;
    await linkStudent(ctx, teacherId, petyaId, { maxLessonsPerWeek: null });
    // Monday 09:00–21:00 in the teacher's zone: the busy stretch at 12:00–13:00 UTC falls inside either way
    await ctx
      .get(AvailabilityUseCase)
      .addRule(teacher(), { weekdays: [1], startMin: 9 * 60, endMin: 21 * 60 });
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('is gated by the feature flag (5.3.3) and by the teacher role', async () => {
    await expect(useCase.status(teacher())).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
    await expect(useCase.connectUrl(teacher())).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
    await ctx.get(FeatureAdminUseCase).setTeacher(actor(adminId, 'ADMIN'), teacherId, 'calendar.google', {
      enabled: true,
    });
    await expect(useCase.status(actor(petyaId, 'STUDENT'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await useCase.status(teacher())).toEqual({ configured: true, connected: false });
  });

  it('connects through OAuth: one-time state, app calendar created, tokens sealed, teacher notified', async () => {
    const url = await useCase.connectUrl(teacher());
    expect(url).toContain('accounts.google.com');
    const state = stateOf(url);
    google.codes.set('code-1', { email: 'anna@gmail.com' });
    await expect(useCase.completeOAuth('not-a-state', 'code-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const result = await useCase.completeOAuth(state, 'code-1');
    expect(result).toMatchObject({
      accountId: teacherId,
      email: 'anna@gmail.com',
      accountName: 'Анна Петрова',
    });
    // the state is spent
    await expect(useCase.completeOAuth(state, 'code-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const row = await connection();
    expect(row.status).toBe('active');
    expect(row.googleEmail).toBe('anna@gmail.com');
    expect(google.calendars.get(row.calendarId!)?.summary).toBe(APP_CALENDAR_NAME);
    // 10.1: nothing in clear in the database
    expect(row.refreshTokenEnc.startsWith('v1.')).toBe(true);
    expect(row.refreshTokenEnc).not.toContain('rt-');
    expect(row.accessTokenEnc).not.toContain('at-');
    expect(await notificationsOf('google.connected')).toHaveLength(1);
    const status = await useCase.status(teacher());
    expect(status).toMatchObject({
      connected: true,
      status: 'active',
      email: 'anna@gmail.com',
      importEnabled: true,
    });
  });

  it('refuses a consent without both calendar scopes or without a refresh token', async () => {
    google.codes.set('code-scopes', { email: 'x@gmail.com', scope: 'openid email' });
    await expect(
      useCase.completeOAuth(stateOf(await useCase.connectUrl(teacher())), 'code-scopes'),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    google.codes.set('code-nort', { email: 'x@gmail.com', refreshToken: null });
    await expect(
      useCase.completeOAuth(stateOf(await useCase.connectUrl(teacher())), 'code-nort'),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect((await connection()).googleEmail).toBe('anna@gmail.com'); // the live connection is untouched
  });

  it('exports lessons to the app calendar and follows reschedules and cancellations (idempotent)', async () => {
    const { lesson } = await ctx.get(CreateLessonUseCase).execute(teacher(), {
      target: { studentId: petyaId },
      startsAt: new Date('2026-11-06T10:00:00Z'),
      durationMin: 60,
      format: 'online',
      meetingUrl: 'https://meet.example/anna',
    });
    await drainOutbox(ctx, tdb); // lesson.created → export requested
    const reports = await job.run();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ error: null, exported: { inserted: 1, updated: 0, deleted: 0 } });
    const cal = await calendarId();
    expect(google.eventsOf(cal)).toHaveLength(1);
    expect(google.eventsOf(cal)[0]).toMatchObject({
      summary: 'Математика — Петя Иванов',
      start: new Date('2026-11-06T10:00:00Z'),
      end: new Date('2026-11-06T11:00:00Z'),
      description: 'Онлайн\nhttps://meet.example/anna',
    });
    // nothing changed: the next due sync writes nothing
    const inserts = google.calls.filter((c) => c === 'insertEvent').length;
    ctx.clock.advance(11 * 60_000);
    expect((await job.run())[0]).toMatchObject({ exported: { inserted: 0, updated: 0, deleted: 0 } });
    expect(google.calls.filter((c) => c === 'insertEvent').length).toBe(inserts);

    await ctx.get(RescheduleLessonUseCase).execute(teacher(), {
      lessonId: lesson.id,
      startsAt: new Date('2026-11-06T12:00:00Z'),
    });
    await drainOutbox(ctx, tdb);
    expect((await job.run())[0]).toMatchObject({ exported: { inserted: 0, updated: 1, deleted: 0 } });
    expect(google.eventsOf(cal)[0]!.start).toEqual(new Date('2026-11-06T12:00:00Z'));

    await ctx.get(CancelLessonUseCase).execute(teacher(), { lessonId: lesson.id, reason: 'Болею' });
    await drainOutbox(ctx, tdb);
    expect((await job.run())[0]).toMatchObject({ exported: { inserted: 0, updated: 0, deleted: 1 } });
    expect(google.eventsOf(cal)).toHaveLength(0);
    const mapping = await tdb.db
      .select()
      .from(googleCalendarEvent)
      .where(eq(googleCalendarEvent.lessonId, lesson.id));
    expect(mapping[0]!.deletedAt).not.toBeNull();
  });

  it('imports busy time as a soft block: fewer open slots, busy for students, a warning for the teacher', async () => {
    const slots = ctx.get(OpenSlotsQuery);
    const range = { start: new Date(`${MON}T00:00:00Z`), end: new Date(`${MON}T23:59:00Z`) };
    const before = await slots.slots(teacher(), { teacherId, studentId: petyaId, range, durationMin: 60 });
    expect(before.slots.length).toBeGreaterThan(0);

    google.busy.set('primary', [busyOnMonday]);
    ctx.clock.advance(11 * 60_000);
    expect((await job.run())[0]).toMatchObject({ imported: 1, error: null });
    expect(await busyRows()).toHaveLength(1);

    const after = await slots.slots(teacher(), { teacherId, studentId: petyaId, range, durationMin: 60 });
    expect(after.slots.length).toBeLessThan(before.slots.length);
    expect(after.slots.some((s) => s.start < busyOnMonday.end && s.end > busyOnMonday.start)).toBe(false);
    // CAL-07: students see it as busy, with no details
    const busy = await ctx.get(BusyQuery).busy(actor(petyaId, 'STUDENT'), petyaId, range);
    expect(busy).toEqual([]); // the student's own time is free
    const teacherBusy = await ctx.get(BusyQuery).busy(teacher(), teacherId, range);
    expect(teacherBusy).toContainEqual(busyOnMonday);
    // the teacher is not blocked (soft), only warned
    const created = await ctx.get(CreateLessonUseCase).execute(teacher(), {
      target: { studentId: petyaId },
      startsAt: new Date(`${MON}T12:00:00Z`),
      durationMin: 60,
    });
    expect(created.externalBusy).toBe(true);
    const day = await ctx.get(DayViewQuery).items(teacherId, range);
    expect(day.map((i) => i.kind)).toEqual(['external', 'lesson']);
    await ctx
      .get(CancelLessonUseCase)
      .execute(teacher(), { lessonId: created.lesson.id, reason: 'Накладка' });
    await drainOutbox(ctx, tdb);
  });

  it('a turned-off import or feature clears the imported busy time at once; turning on re-syncs', async () => {
    await useCase.updateSettings(teacher(), { importEnabled: false });
    expect(await busyRows()).toHaveLength(0);
    await useCase.updateSettings(teacher(), { importEnabled: true });
    expect((await job.run())[0]).toMatchObject({ imported: 1 });
    expect(await busyRows()).toHaveLength(1);

    const admin = actor(adminId, 'ADMIN');
    await ctx.get(FeatureAdminUseCase).setTeacher(admin, teacherId, 'calendar.google', { enabled: false });
    await drainOutbox(ctx, tdb); // feature.changed → busy dropped
    expect(await busyRows()).toHaveLength(0);
    ctx.clock.advance(11 * 60_000);
    expect((await job.run())[0]).toMatchObject({ skipped: 'feature_off' });
    await ctx.get(FeatureAdminUseCase).setTeacher(admin, teacherId, 'calendar.google', { enabled: true });
    await drainOutbox(ctx, tdb);
    expect((await job.run())[0]).toMatchObject({ imported: 1, skipped: null });
    await expect(
      useCase.updateSettings(teacher(), { busyCalendarIds: ['primary', 'bad id!'] }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await useCase.updateSettings(teacher(), {
      busyCalendarIds: ['primary', 'work@group.calendar.google.com'],
    });
    expect((await job.run())[0]).toMatchObject({ imported: 1 });
    expect(google.calls.at(-1)).toBe('freeBusy:primary,work@group.calendar.google.com');
  });

  it('survives a Google outage (previous state stays) and parks a revoked token in `error` with one message', async () => {
    google.outage = new Error('503 backend error');
    ctx.clock.advance(11 * 60_000);
    const [report] = await job.run();
    expect(report!.error).toContain('503');
    expect((await connection()).status).toBe('active');
    expect((await connection()).lastError).toContain('503');
    expect(await busyRows()).toHaveLength(1);
    google.outage = null;
    ctx.clock.advance(11 * 60_000);
    expect((await job.run())[0]!.error).toBeNull();
    expect((await connection()).lastError).toBeNull();

    // Google revokes the consent; the cached access token expires with time
    for (const rt of google.issuedRefreshTokens()) google.revoked.add(rt);
    ctx.clock.advance(2 * HOUR_MS);
    const [failed] = await job.run();
    expect(failed!.error).toContain('auth');
    expect((await connection()).status).toBe('error');
    expect(await busyRows()).toHaveLength(0);
    expect(await notificationsOf('google.sync_failed')).toHaveLength(1);
    ctx.clock.advance(11 * 60_000);
    expect(await job.run()).toHaveLength(0); // not retried until the teacher reconnects
    expect(await useCase.status(teacher())).toMatchObject({ connected: true, status: 'error' });
  });

  it('reconnecting replaces the connection (the old calendar goes when Google still lets us); disconnect revokes everything', async () => {
    const oldCalendar = await calendarId();
    const oldId = (await connection()).id;
    const cal = await connect('code-2', 'anna2@gmail.com');
    expect(cal).not.toBe(oldCalendar);
    // the previous token was revoked by Google: the orphaned calendar cannot be removed, the teacher keeps it
    expect(google.calendars.has(oldCalendar)).toBe(true);
    expect((await connection()).id).not.toBe(oldId);
    expect((await connection()).googleEmail).toBe('anna2@gmail.com');
    expect((await job.run())[0]).toMatchObject({ error: null }); // exports pending lessons of the new calendar

    await useCase.disconnect(teacher());
    expect(await repo.findLive(teacherId)).toBeNull();
    const rows = await tdb.db
      .select()
      .from(googleCalendarConnection)
      .where(eq(googleCalendarConnection.accountId, teacherId));
    expect(rows.every((r) => r.status === 'revoked' && r.revokedAt !== null)).toBe(true);
    expect(google.calendars.has(cal)).toBe(false);
    expect(google.revoked.size).toBeGreaterThanOrEqual(2);
    // the sync job never touches a revoked connection, even when asked
    expect(await job.run()).toHaveLength(0);
    expect(await busyRows()).toHaveLength(0);
    expect(await useCase.status(teacher())).toEqual({ configured: true, connected: false });
    await expect(useCase.disconnect(teacher())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reconnecting with the same Google account removes the previous app calendar but keeps the grant', async () => {
    const first = await connect('code-3');
    const revokedBefore = google.revoked.size;
    const tokensBefore = google.issuedRefreshTokens().length;
    const second = await connect('code-4'); // same e-mail: one grant per user × client, so no revoke
    expect(second).not.toBe(first);
    expect(google.calendars.has(first)).toBe(false);
    expect(google.calendars.has(second)).toBe(true);
    expect(google.revoked.size).toBe(revokedBefore);
    expect(google.issuedRefreshTokens().length).toBe(tokensBefore + 1);
    // a different Google account: the previous grant is revoked and its calendar removed with the old token
    const third = await connect('code-5', 'other@gmail.com');
    expect(google.calendars.has(second)).toBe(false);
    expect(google.calendars.has(third)).toBe(true);
    expect(google.revoked.size).toBe(revokedBefore + 1);
  });

  it('a Google failure after the state was spent revokes the issued grant and reports google_error', async () => {
    const url = await useCase.connectUrl(teacher());
    google.codes.set('code-6', { email: 'anna@gmail.com' });
    google.outage = new Error('503');
    const issued = google.issuedRefreshTokens().length;
    await expect(useCase.completeOAuth(stateOf(url), 'code-6')).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'google_error' },
    });
    google.outage = null;
    expect(google.revoked.has(google.issuedRefreshTokens()[issued]!)).toBe(true); // the token issued for code-6
    await expect(useCase.completeOAuth(stateOf(url), 'code-6')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await connection()).googleEmail).toBe('other@gmail.com'); // the live connection is untouched
  });

  it('runs one sync of a connection at a time (advisory lock)', async () => {
    const sync = ctx.get(GoogleSyncService);
    const id = (await connection()).id;
    const reports = await Promise.all([sync.sync(id), sync.sync(id)]);
    const skipped = reports.map((r) => r.skipped);
    expect(skipped).toContain(null);
    expect(skipped).toContain('locked');
  });
});
