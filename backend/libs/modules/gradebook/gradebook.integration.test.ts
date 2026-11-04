import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount } from '@test/factories.js';
import { drainOutbox } from '@test/outbox.js';
import { linkStudent, MATH_ID, PHYSICS_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import type { Actor } from '@modules/access/actor.js';
import { FeatureAdminUseCase } from '@modules/access/features/feature-admin.use-case.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { ContentModule } from '@modules/content/content.module.js';
import { FilesModule } from '@modules/files/files.module.js';
import { HomeworkModule } from '@modules/homework/homework.module.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { notification } from '@modules/notifications/schema.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { EndLinkUseCase } from '@modules/people/links/end-link.use-case.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { UpdateStudentCardUseCase } from '@modules/people/links/update-student-card.use-case.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { GradeEntriesUseCase } from './grade-entries.use-case.js';
import { GradeEntryRepository } from './grade-entry.repository.js';
import { GradebookModule } from './gradebook.module.js';
import { GradebookQuery } from './gradebook.query.js';
import { JournalRepository } from './journal.repository.js';
import { JournalsUseCase } from './journals.use-case.js';

describe('M6-01/M6-02 gradebook: journals per subject, records with history, proposals, scale, stats, notifications', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let journals: JournalsUseCase;
  let entries: GradeEntriesUseCase;
  let query: GradebookQuery;
  let teacherId: string;
  let otherTeacherId: string;
  let petyaId: string;
  let mamaId: string;
  let linkId: string;
  const actor = (id: string, role: Actor['roles'][number]): Actor => ({
    accountId: id,
    roles: [role],
    status: 'active',
    source: 'bot',
  });
  const teacher = () => actor(teacherId, 'TEACHER');
  const petya = () => actor(petyaId, 'STUDENT');
  const mama = () => actor(mamaId, 'PARENT');
  const sent = (type: string, recipientId?: string) =>
    tdb.db
      .select()
      .from(notification)
      .where(
        and(
          eq(notification.typeCode, type),
          recipientId ? eq(notification.recipientId, recipientId) : undefined,
        ),
      );

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(
      tdb,
      [
        AccessModule,
        PeopleModule,
        GradebookModule,
        FilesModule,
        ScheduleModule,
        ContentModule,
        HomeworkModule,
        NotificationsModule,
      ],
      { now: '2026-11-04T10:00:00Z' },
    );
    journals = ctx.get(JournalsUseCase);
    entries = ctx.get(GradeEntriesUseCase);
    query = ctx.get(GradebookQuery);
    teacherId = (
      await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Анна', timezone: 'Europe/Minsk' })
    ).id;
    otherTeacherId = (await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Олег' })).id;
    const profiles = ctx.get(TeacherProfileRepository);
    await profiles.upsert(teacherId, { subjectIds: [MATH_ID, PHYSICS_ID], onboardedAt: ctx.clock.now() });
    await profiles.upsert(otherTeacherId, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now() });
    petyaId = (
      await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Петя', timezone: 'Europe/Minsk' })
    ).id;
    mamaId = (await createAccount(tdb.txm, { roles: ['PARENT'], firstName: 'Мама' })).id;
    await ctx.get(FamilyLinkRepository).insert({
      parentId: mamaId,
      studentId: petyaId,
      invitedBy: teacherId,
      invitationId: null,
      confirmedAt: ctx.clock.now(),
    });
    const link = await linkStudent(ctx, teacherId, petyaId, { subjectIds: [MATH_ID] });
    linkId = link.id;
    // the port is bound by the gradebook module; linkStudent bypasses the use-case, so provision explicitly
    await journals.ensureForLink({
      linkId: link.id,
      teacherId,
      studentId: petyaId,
      subjectIds: link.subjectIds,
    });
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('JRN-01/02: three journals per subject, a new subject on the card adds three more, re-provisioning is idempotent', async () => {
    const first = await query.teacherJournals(teacher(), linkId);
    expect(first.journals.map((j) => j.journal.type)).toEqual(['school', 'tests', 'custom']);
    await ctx.get(UpdateStudentCardUseCase).execute(teacher(), linkId, { subjectIds: [MATH_ID, PHYSICS_ID] });
    const second = await query.teacherJournals(teacher(), linkId);
    expect(second.journals).toHaveLength(6);
    expect(second.journals.filter((j) => j.journal.subjectId === PHYSICS_ID)).toHaveLength(3);
    await journals.ensureForLink({
      linkId,
      teacherId,
      studentId: petyaId,
      subjectIds: [MATH_ID, PHYSICS_ID],
    });
    expect((await query.teacherJournals(teacher(), linkId)).journals).toHaveLength(6);
    // 8.0: another teacher cannot see the card
    await expect(query.teacherJournals(actor(otherTeacherId, 'TEACHER'), linkId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('UC-29: the teacher records school marks; history, audit, stats and the student notification follow', async () => {
    const school = await entries.journalFor(teacher(), petyaId, MATH_ID, 'school');
    const a = await entries.add(teacher(), { journalId: school.id, value: 8, date: '2026-11-02' });
    const b = await entries.add(teacher(), {
      journalId: school.id,
      value: 6,
      category: 'control',
      weight: 2,
      comment: 'Невнимательность',
    });
    expect(a).toMatchObject({
      valueNumeric: 8,
      category: 'current',
      status: 'confirmed',
      source: 'teacher',
      weight: 1,
    });
    expect(b).toMatchObject({ valueNumeric: 6, category: 'control', weight: 2, date: '2026-11-04' });
    await expect(entries.add(teacher(), { journalId: school.id, value: 11 })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(
      entries.add(teacher(), { journalId: school.id, value: 7, date: '2026-11-05' }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await drainOutbox(ctx, tdb);
    const added = (await sent('grade.added', petyaId)).sort((x, y) => x.dedupeKey.localeCompare(y.dedupeKey));
    expect(added).toHaveLength(2);
    expect(added.find((n) => n.dedupeKey.startsWith(`grade.added:${a.id}:`))!.payload).toMatchObject({
      value: '8',
      subject: 'Математика',
      teacher: 'Анна User',
      kind: 'текущая',
    });
    expect(added.find((n) => n.dedupeKey.startsWith(`grade.added:${b.id}:`))!.payload).toMatchObject({
      value: '6',
      kind: 'контрольная',
      comment: 'Невнимательность',
    });
    // JRN-05: edit keeps the previous state, delete keeps the row
    const edited = await entries.update(teacher(), a.id, { value: 9 });
    expect(edited.version).toBe(2);
    const history = await ctx.get(GradeEntryRepository).listHistory(a.id);
    expect(history.map((h) => h.action)).toEqual(['created', 'updated']);
    expect(history[1]!.before).toMatchObject({ valueNumeric: 8 });
    const card = await query.teacherCard(teacher(), school.id);
    expect(card.entries.map((e) => e.valueNumeric)).toEqual([9, 6]);
    expect(card.stats).toMatchObject({ type: 'school', stats: { count: 2, average: 7 } }); // (9 + 12) / 3
    const october = await query.teacherCard(teacher(), school.id, { from: '2026-10-01', to: '2026-10-31' });
    expect(october.stats.stats.count).toBe(0);
    await entries.remove(teacher(), b.id);
    expect((await query.teacherCard(teacher(), school.id)).entries).toHaveLength(1);
    const audit = await ctx.get(AuditService).query({ entityType: 'grade_entry', page: 1, limit: 20 });
    expect(audit.items.map((r) => r.action).sort()).toEqual([
      'grade.added',
      'grade.added',
      'grade.removed',
      'grade.updated',
    ]);
    await drainOutbox(ctx, tdb);
    // the removed mark's pending notification is cancelled (NTF-05 spirit); an edit sends nothing new
    const forB = (await sent('grade.added', petyaId)).filter((n) =>
      n.dedupeKey.startsWith(`grade.added:${b.id}:`),
    );
    expect(forB.map((n) => n.status)).toEqual(['cancelled']);
    expect(await sent('grade.added', petyaId)).toHaveLength(2);
    // a foreign teacher: NOT_FOUND on the journal and the entry
    await expect(
      entries.add(actor(otherTeacherId, 'TEACHER'), { journalId: school.id, value: 5 }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(entries.update(actor(otherTeacherId, 'TEACHER'), a.id, { value: 5 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('5.11.3: tests with kinds, maxima and parts; target and the ▲▼ dynamics', async () => {
    const tests = await entries.journalFor(teacher(), petyaId, MATH_ID, 'tests');
    const kinds = await journals.testKinds(teacher());
    expect(kinds.map((k) => k.name)).toContain('ЦТ');
    const custom = await journals.addTestKind(teacher(), 'Олимпиада');
    await expect(journals.addTestKind(teacher(), 'олимпиада')).rejects.toMatchObject({ code: 'CONFLICT' });
    const ct = kinds.find((k) => k.name === 'ЦТ')!;
    await entries.add(teacher(), { journalId: tests.id, value: 60, testKindId: ct.id, date: '2026-10-01' });
    await entries.add(teacher(), {
      journalId: tests.id,
      value: 42,
      max: 60,
      testKindId: custom.id,
      date: '2026-10-15',
      parts: { a: 30, b: 12 },
    });
    await expect(entries.add(teacher(), { journalId: tests.id, value: 101 })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await journals.updateSettings(teacher(), tests.id, { targetPercent: 80 });
    await expect(
      journals.updateSettings(
        teacher(),
        (await entries.journalFor(teacher(), petyaId, MATH_ID, 'school')).id,
        { targetPercent: 80 },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const card = await query.teacherCard(teacher(), tests.id);
    expect(card.stats).toMatchObject({
      type: 'tests',
      stats: { count: 2, delta: 10, average: 65, toTarget: -10 },
    });
    expect(card.stats.type === 'tests' && card.stats.stats.best?.percent).toBe(70);
    expect([...card.deltas.values()]).toEqual([null, 10]);
    expect(card.lookups.testKinds.get(custom.id)?.name).toBe('Олимпиада');
    await journals.removeTestKind(teacher(), custom.id);
    expect((await journals.testKinds(teacher())).some((k) => k.id === custom.id)).toBe(false);
    // the archived kind still resolves on old records
    expect((await query.teacherCard(teacher(), tests.id)).lookups.testKinds.get(custom.id)?.name).toBe(
      'Олимпиада',
    );
  });

  it('5.11.4 / JRN-06: the custom scale is required for custom records; a used value is archived, not deleted', async () => {
    const custom = await entries.journalFor(teacher(), petyaId, MATH_ID, 'custom');
    await expect(
      entries.add(teacher(), { journalId: custom.id, scaleValueId: custom.id }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'scale_missing' },
    });
    const scale = await journals.putCustomScale(teacher(), {
      values: [
        { label: 'Отлично', emoji: '⭐', weight: 3 },
        { label: 'Хорошо', weight: 2 },
        { label: 'Старайся', emoji: '💪', weight: 1 },
      ],
    });
    expect(scale.values.map((v) => v.label)).toEqual(['Отлично', 'Хорошо', 'Старайся']);
    const star = scale.values[0]!;
    const e = await entries.add(teacher(), { journalId: custom.id, scaleValueId: star.id });
    expect(e).toMatchObject({ scaleValueId: star.id, valueNumeric: 3 });
    // PUT without «Отлично»: archived (used), «Хорошо» renamed stays by label match, a new value appears
    const next = await journals.putCustomScale(teacher(), {
      title: 'Звёзды',
      values: [
        { label: 'Хорошо', emoji: '👍' },
        { label: 'Супер', emoji: '🔥' },
      ],
    });
    expect(next.scale.title).toBe('Звёзды');
    const live = next.values.filter((v) => !v.archivedAt).map((v) => v.label);
    expect(live).toEqual(['Хорошо', 'Супер']);
    expect(next.values.find((v) => v.id === star.id)?.archivedAt).not.toBeNull();
    await expect(
      entries.add(teacher(), { journalId: custom.id, scaleValueId: star.id }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    const card = await query.teacherCard(teacher(), custom.id);
    expect(card.lookups.scaleValues.get(star.id)?.label).toBe('Отлично'); // history keeps the old value
    expect(card.stats).toMatchObject({
      type: 'custom',
      stats: { count: 1, byValue: [{ scaleValueId: star.id, count: 1 }] },
    });
    await expect(journals.putCustomScale(teacher(), { values: [{ label: 'Одно' }] })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(
      journals.archiveScaleValue(teacher(), next.values.find((v) => v.label === 'Супер')!.id),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('UC-30: a student or a parent proposes a school mark; the teacher confirms or rejects; auto-confirm skips the wait', async () => {
    const school = await entries.journalFor(teacher(), petyaId, MATH_ID, 'school');
    const p1 = await entries.propose(petya(), {
      journalId: school.id,
      value: 7,
      category: 'control',
      date: '2026-11-03',
    });
    expect(p1).toMatchObject({ status: 'pending', source: 'student', createdBy: petyaId });
    const p2 = await entries.propose(mama(), { journalId: school.id, value: 9 });
    expect(p2).toMatchObject({ status: 'pending', source: 'parent', createdBy: mamaId });
    // only school journals, only visible ones, only own
    const tests = await entries.journalFor(teacher(), petyaId, MATH_ID, 'tests');
    await expect(entries.propose(petya(), { journalId: tests.id, value: 50 })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    const stranger = (await createAccount(tdb.txm, { roles: ['STUDENT'] })).id;
    await expect(
      entries.propose(actor(stranger, 'STUDENT'), { journalId: school.id, value: 5 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await journals.updateSettings(teacher(), school.id, { visibleToStudent: false });
    await expect(entries.propose(petya(), { journalId: school.id, value: 5 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(query.personCard(petya(), school.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await query.personCard(mama(), school.id)).entries.length).toBeGreaterThan(0);
    await journals.updateSettings(teacher(), school.id, { visibleToStudent: true });
    // pending marks are invisible in the confirmed list and the stats
    const card = await query.teacherCard(teacher(), school.id);
    expect(card.pending.map((e) => e.id).sort()).toEqual([p1.id, p2.id].sort());
    expect(card.entries.some((e) => e.id === p1.id)).toBe(false);
    expect((await query.pending(teacher())).map((p) => p.proposer?.firstName).sort()).toEqual([
      'Мама',
      'Петя',
    ]);
    await drainOutbox(ctx, tdb);
    expect((await sent('grade.proposed', teacherId)).map((n) => n.payload['by']).sort()).toEqual([
      'Мама User',
      'Петя User',
    ]);
    const confirmed = await entries.confirm(teacher(), p1.id);
    expect(confirmed.status).toBe('confirmed');
    const rejected = await entries.reject(teacher(), p2.id);
    expect(rejected.status).toBe('rejected');
    await expect(entries.confirm(teacher(), p2.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await drainOutbox(ctx, tdb);
    expect((await sent('grade.rejected', mamaId)).length).toBe(1);
    // the confirmed mark reaches the student — by now as part of today's digest (NTF-07: > 3 marks today)
    const direct = (await sent('grade.added', petyaId)).some((n) =>
      n.dedupeKey.startsWith(`grade.added:${p1.id}:`),
    );
    const digest = (await sent('grade.digest', petyaId)).length > 0;
    expect(direct || digest).toBe(true);
    // auto-confirm
    expect(await journals.toggleAutoConfirm(teacher())).toBe(true);
    const auto = await entries.propose(petya(), { journalId: school.id, value: 10 });
    expect(auto.status).toBe('confirmed');
    await journals.toggleAutoConfirm(teacher());
  });

  it('NTF-07: beyond three marks a day the student gets one digest instead of single messages', async () => {
    const school = await entries.journalFor(teacher(), petyaId, PHYSICS_ID, 'school');
    const before = (await sent('grade.added', petyaId)).length;
    for (const value of [5, 6, 7, 8, 9]) await entries.add(teacher(), { journalId: school.id, value });
    await drainOutbox(ctx, tdb);
    const after = (await sent('grade.added', petyaId)).length;
    expect(after - before).toBeLessThanOrEqual(3);
    const digests = await tdb.db
      .select()
      .from(notification)
      .where(like(notification.dedupeKey, `grade.digest:${teacherId}:${petyaId}:%`));
    expect(digests).toHaveLength(1);
  });

  it('5.3.3: a journal feature off hides the journal and refuses writes; a reader sees the archive after the link ends', async () => {
    const admin = (await createAccount(tdb.txm, { roles: ['ADMIN'] })).id;
    await ctx
      .get(FeatureAdminUseCase)
      .setTeacher(actor(admin, 'ADMIN'), teacherId, 'journal.custom', { enabled: false });
    const list = await query.teacherJournals(teacher(), linkId);
    expect(list.journals.some((j) => j.journal.type === 'custom')).toBe(false);
    const custom = (await ctx.get(JournalRepository).listByLink(linkId)).find((j) => j.type === 'custom')!;
    await expect(
      entries.add(teacher(), { journalId: custom.id, scaleValueId: custom.id }),
    ).rejects.toMatchObject({
      code: 'FEATURE_DISABLED',
    });
    expect((await query.forStudent(petya()))[0]!.journals.some((j) => j.journal.type === 'custom')).toBe(
      false,
    );
    await ctx
      .get(FeatureAdminUseCase)
      .setTeacher(actor(admin, 'ADMIN'), teacherId, 'journal.custom', { enabled: true });
    // the link ends: the student keeps a read-only archive, the teacher cannot write
    await ctx
      .get(EndLinkUseCase)
      .execute(teacher(), linkId, { reason: 'removed_by_teacher', message: 'Пока' });
    const groups = await query.forStudent(petya());
    expect(groups[0]).toMatchObject({ view: 'archive' });
    expect(groups[0]!.journals.length).toBeGreaterThan(0);
    const school = (await ctx.get(JournalRepository).listByLink(linkId)).find((j) => j.type === 'school')!;
    await expect(entries.add(teacher(), { journalId: school.id, value: 5 })).rejects.toMatchObject({
      code: 'LINK_NOT_ACTIVE',
    });
    await expect(entries.propose(petya(), { journalId: school.id, value: 5 })).rejects.toMatchObject({
      code: 'LINK_NOT_ACTIVE',
    });
    expect((await ctx.get(TeacherStudentRepository).findById(linkId))?.status).toBe('ended');
  });
});
