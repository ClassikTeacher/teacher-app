import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount } from '@test/factories.js';
import { drainOutbox } from '@test/outbox.js';
import { linkStudent, MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import type { Actor } from '@modules/access/actor.js';
import { FileRepository } from '@modules/files/file.repository.js';
import { IngestFileUseCase } from '@modules/files/ingest-file.use-case.js';
import { TelegramFileDownloader } from '@modules/files/telegram-file-downloader.js';
import { FilesModule } from '@modules/files/files.module.js';
import { NotificationsModule } from '@modules/notifications/notifications.module.js';
import { notification } from '@modules/notifications/schema.js';
import { GroupsUseCase } from '@modules/people/groups/groups.use-case.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { CreateLessonUseCase } from '@modules/schedule/lessons/create-lesson.use-case.js';
import { LessonReportUseCase } from '@modules/schedule/lessons/lesson-report.use-case.js';
import { ScheduleModule } from '@modules/schedule/schedule.module.js';
import { ContentAccessQuery } from './content-access.query.js';
import { ContentModule } from './content.module.js';
import { GrantsUseCase } from './grants.use-case.js';
import { LessonContentHandler } from './lesson-content.handler.js';
import { MaterialsQuery } from './materials.query.js';
import { MaterialsUseCase } from './materials.use-case.js';

describe('M5-02 content: materials, collections, grants (MAT-01/02), lesson release, notifications', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let teacherId: string;
  let petyaId: string;
  let mashaId: string;
  const teacher = (): Actor => ({
    accountId: teacherId,
    roles: ['TEACHER'],
    status: 'active',
    source: 'bot',
  });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [
      AccessModule,
      PeopleModule,
      FilesModule,
      ScheduleModule,
      ContentModule,
      NotificationsModule,
    ]);
    teacherId = (await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Анна', lastName: 'Петрова' }))
      .id;
    await ctx
      .get(TeacherProfileRepository)
      .upsert(teacherId, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now() });
    petyaId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Петя' })).id;
    mashaId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Маша' })).id;
    await linkStudent(ctx, teacherId, petyaId);
    await linkStudent(ctx, teacherId, mashaId);
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('a link material granted to a student is visible to them, not to others; revoking hides it (MAT-02)', async () => {
    const materials = ctx.get(MaterialsUseCase);
    const grants = ctx.get(GrantsUseCase);
    const access = ctx.get(ContentAccessQuery);
    const m = await materials.create(teacher(), {
      kind: 'link',
      title: 'Формулы',
      url: 'https://example.org/f',
    });
    expect(await access.materialFor(petyaId, m.id)).toBeNull();
    const { grant, studentIds } = await grants.grant(teacher(), {
      subjectType: 'material',
      subjectId: m.id,
      grantee: { studentId: petyaId },
    });
    expect(studentIds).toEqual([petyaId]);
    expect((await access.materialFor(petyaId, m.id))?.id).toBe(m.id);
    expect(await access.materialFor(mashaId, m.id)).toBeNull();
    expect((await access.teachersFor(petyaId)).map((t) => t.id)).toEqual([teacherId]);
    await drainOutbox(ctx, tdb);
    const sent = await tdb.db
      .select()
      .from(notification)
      .where(eq(notification.typeCode, 'material.granted'));
    expect(sent.map((n) => n.recipientId)).toEqual([petyaId]);
    expect(sent[0]!.payload).toMatchObject({ title: 'Формулы', teacher: 'Анна Петрова' });
    await access.markViewed(petyaId, m.id);
    expect((await ctx.get(MaterialsQuery).card(teacherId, m.id)).views.map((v) => v.studentId)).toEqual([
      petyaId,
    ]);
    await grants.revoke(teacher(), grant.id);
    expect(await access.materialFor(petyaId, m.id)).toBeNull();
  });

  it('a group grant follows membership: a member joining later sees the collection; delayed opening waits', async () => {
    const materials = ctx.get(MaterialsUseCase);
    const grants = ctx.get(GrantsUseCase);
    const access = ctx.get(ContentAccessQuery);
    const group = await ctx.get(GroupsUseCase).create(teacher(), { name: '9А', subjectId: MATH_ID });
    await ctx.get(GroupsUseCase).addMember(teacher(), group.id, petyaId);
    const col = await materials.createCollection(teacher(), {
      title: 'Механика',
      periodFrom: '2026-11-01',
      periodTo: '2026-11-30',
    });
    const text = await materials.create(teacher(), { kind: 'text', title: 'Конспект', body: 'F = ma' });
    await materials.addToCollection(teacher(), col.id, text.id);
    const opensAt = new Date('2026-11-01T06:00:00Z');
    await grants.grant(teacher(), {
      subjectType: 'collection',
      subjectId: col.id,
      grantee: { groupId: group.id },
      availableFrom: opensAt,
    });
    expect(await access.materialFor(petyaId, text.id)).toBeNull(); // not yet open
    await drainOutbox(ctx, tdb); // the announcement is scheduled for the opening moment
    ctx.clock.set('2026-11-02T10:00:00Z');
    expect((await access.materialFor(petyaId, text.id))?.id).toBe(text.id);
    expect(await access.materialFor(mashaId, text.id)).toBeNull();
    await ctx.get(GroupsUseCase).addMember(teacher(), group.id, mashaId);
    const lib = await access.libraryFor(mashaId, teacherId);
    expect(lib.collections.map((c) => c.collection.title)).toEqual(['Механика']);
    expect(lib.collections[0]!.materials.map((m) => m.title)).toEqual(['Конспект']);
    await drainOutbox(ctx, tdb);
    const forPetya = await tdb.db.select().from(notification).where(eq(notification.recipientId, petyaId));
    const delayed = forPetya.find(
      (n) => n.typeCode === 'material.granted' && (n.payload as { kind?: string }).kind === 'collection',
    );
    expect(delayed?.dueAt.toISOString()).toBe(opensAt.toISOString());
  });

  it('lesson materials: «до» at once, «после» when the report is filed; a file material needs an attached file', async () => {
    const materials = ctx.get(MaterialsUseCase);
    const access = ctx.get(ContentAccessQuery);
    const before = await materials.create(teacher(), {
      kind: 'text',
      title: 'До занятия',
      body: 'Прочитать §1',
    });
    const after = await materials.create(teacher(), {
      kind: 'text',
      title: 'После занятия',
      body: 'Решения',
    });
    ctx.clock.set('2026-11-03T09:00:00Z');
    const { lesson } = await ctx.get(CreateLessonUseCase).execute(teacher(), {
      target: { studentId: petyaId },
      startsAt: new Date('2026-11-03T10:00:00Z'),
      durationMin: 60,
    });
    await materials.attachToLesson(teacher(), lesson.id, { materialId: before.id }, 'before');
    await materials.attachToLesson(teacher(), lesson.id, { materialId: after.id }, 'after');
    expect((await access.materialFor(petyaId, before.id))?.id).toBe(before.id);
    expect(await access.materialFor(petyaId, after.id)).toBeNull();
    ctx.clock.set('2026-11-03T11:30:00Z');
    await ctx.get(LessonReportUseCase).complete(teacher(), lesson.id, {
      topic: 'Кинематика',
      attendance: [{ studentId: petyaId, attendance: 'present' }],
    });
    await drainOutbox(ctx, tdb);
    expect((await access.materialFor(petyaId, after.id))?.id).toBe(after.id);
    await drainOutbox(ctx, tdb); // a second delivery of the same event hands nothing out twice
    const grantsOfAfter = await ctx.get(GrantsUseCase).listForSubject(teacher(), 'material', after.id);
    expect(grantsOfAfter.length).toBe(1);
    await expect(
      materials.create(teacher(), {
        kind: 'file',
        title: 'Нет файла',
        fileId: '019a0000-0000-7000-8000-00000000ffff',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await ctx.get(FileRepository).usedBytes(teacherId)).toBe(0);

    // a revoked lesson grant is not re-issued by a redelivered event; a removed participant loses the grants
    const grants = ctx.get(GrantsUseCase);
    await grants.revoke(teacher(), grantsOfAfter[0]!.id);
    await ctx.get(LessonContentHandler)['handOut'](lesson.id, [petyaId], ['after']);
    expect(await access.materialFor(petyaId, after.id)).toBeNull();
    expect(await grants.revokeLessonGrants(lesson.id, petyaId)).toBe(1); // the «before» grant
    expect(await access.materialFor(petyaId, before.id)).toBeNull();
  });

  it('M5-REVIEW H-2: deleting a file material erases the object and frees the teacher quota', async () => {
    const files = ctx.get(FileRepository);
    const PDF = Buffer.from('%PDF-1.4 1 0 obj << /Type /Catalog >> endobj', 'latin1');
    ctx.get(TelegramFileDownloader).transport = async () => PDF;
    const stored = await ctx.get(IngestFileUseCase).execute({
      actor: teacher(),
      ownerTeacherId: teacherId,
      bot: 'staff',
      api: { token: 't' } as never,
      telegram: { fileId: 'tg-del', fileUniqueId: 'u-del', fileName: 'Удалить.pdf', isDocument: true },
    });
    const m = await ctx
      .get(MaterialsUseCase)
      .create(teacher(), { kind: 'file', title: 'Временный', fileId: stored.id });
    await ctx
      .get(GrantsUseCase)
      .grant(teacher(), { subjectType: 'material', subjectId: m.id, grantee: { studentId: petyaId } });
    expect(await files.usedBytes(teacherId)).toBe(PDF.length);
    await ctx.get(MaterialsUseCase).delete(teacher(), m.id);
    expect(await files.usedBytes(teacherId)).toBe(0);
    expect((await files.findById(stored.id))!.status).toBe('deleted');
    expect(await ctx.get(ContentAccessQuery).materialFor(petyaId, m.id)).toBeNull();
  });

  it('an archived collection hides its materials even by id; foreign ids are refused (8.0)', async () => {
    const materials = ctx.get(MaterialsUseCase);
    const grants = ctx.get(GrantsUseCase);
    const access = ctx.get(ContentAccessQuery);
    const col = await materials.createCollection(teacher(), { title: 'Архивная' });
    const m = await materials.create(teacher(), { kind: 'text', title: 'Внутри', body: '...' });
    await materials.addToCollection(teacher(), col.id, m.id);
    await grants.grant(teacher(), {
      subjectType: 'collection',
      subjectId: col.id,
      grantee: { studentId: petyaId },
    });
    expect((await access.materialFor(petyaId, m.id))?.id).toBe(m.id);
    expect((await access.collectionFor(petyaId, col.id))?.materials.map((x) => x.id)).toEqual([m.id]);
    await materials.archiveCollection(teacher(), col.id);
    expect(await access.materialFor(petyaId, m.id)).toBeNull();
    expect(await access.collectionFor(petyaId, col.id)).toBeNull();

    const other = (await createAccount(tdb.txm, { roles: ['TEACHER'] })).id;
    const stranger: Actor = { accountId: other, roles: ['TEACHER'], status: 'active', source: 'bot' };
    await expect(materials.addToCollection(stranger, col.id, m.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      grants.grant(stranger, { subjectType: 'material', subjectId: m.id, grantee: { studentId: petyaId } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      grants.grant(teacher(), {
        subjectType: 'material',
        subjectId: m.id,
        grantee: { studentId: petyaId },
        availableUntil: new Date(0),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
