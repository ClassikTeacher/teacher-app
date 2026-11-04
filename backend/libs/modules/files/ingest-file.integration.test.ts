import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Api } from 'grammy';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount } from '@test/factories.js';
import { linkStudent, MATH_ID } from '@test/people.js';
import { AppError } from '@shared/errors/app-error.js';
import { AccessModule } from '@modules/access/access.module.js';
import type { Actor } from '@modules/access/actor.js';
import { FeatureAdminUseCase } from '@modules/access/features/feature-admin.use-case.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { FileDeliveryService } from './file-delivery.service.js';
import { FileMaintenanceJob } from './file-maintenance.job.js';
import { FileRepository } from './file.repository.js';
import { FileStorage } from './file-storage.js';
import { FilesModule } from './files.module.js';
import { IngestFileUseCase } from './ingest-file.use-case.js';
import { TelegramFileDownloader } from './telegram-file-downloader.js';
import { UPLOADS_PER_HOUR, UploadRateLimit } from './upload-rate-limit.js';
import { VirusScanner } from './virus-scanner.js';

const PDF = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj << /Type /Catalog >> endobj\n', 'latin1');
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0]);

describe('M5-01 file pipeline: Telegram → type → antivirus → S3 → quota, cache per bot, GC', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let teacherId: string;
  let studentId: string;
  let adminId: string;
  const blobs = new Map<string, Buffer>();
  const api = { token: 't', getFile: vi.fn() } as unknown as Api;
  const actor = (accountId: string, role: 'TEACHER' | 'STUDENT' | 'ADMIN'): Actor => ({
    accountId,
    roles: [role],
    status: 'active',
    source: 'bot',
  });
  const tg = (fileId: string, fileName?: string, size?: number) => ({
    fileId,
    fileUniqueId: `u-${fileId}`,
    fileName,
    size,
    isDocument: true,
  });
  const ingest = (by: Actor, fileId: string, fileName?: string, size?: number) =>
    ctx.get(IngestFileUseCase).execute({
      actor: by,
      ownerTeacherId: teacherId,
      bot: by.roles[0] === 'TEACHER' ? 'staff' : 'student',
      api,
      telegram: tg(fileId, fileName, size),
    });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [AccessModule, PeopleModule, FilesModule]);
    ctx.get(TelegramFileDownloader).transport = async (_api, fileId) => {
      const bytes = blobs.get(fileId);
      if (!bytes) throw new Error(`no blob ${fileId}`);
      return bytes;
    };
    teacherId = (await createAccount(tdb.txm, { roles: ['TEACHER'], firstName: 'Анна' })).id;
    await ctx
      .get(TeacherProfileRepository)
      .upsert(teacherId, { subjectIds: [MATH_ID], onboardedAt: ctx.clock.now() });
    studentId = (await createAccount(tdb.txm, { roles: ['STUDENT'], firstName: 'Петя' })).id;
    await linkStudent(ctx, teacherId, studentId);
    adminId = (await createAccount(tdb.txm, { roles: ['ADMIN'] })).id;
    blobs.set('pdf-1', PDF);
    blobs.set('exe-1', EXE);
    blobs.set('big', Buffer.concat([PDF, Buffer.alloc(3000)]));
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('stores a student upload: type by signature, S3 object, draft row, quota charged, student-bot cache', async () => {
    const row = await ingest(actor(studentId, 'STUDENT'), 'pdf-1', 'virus.exe');
    expect(row).toMatchObject({
      ext: 'pdf',
      mime: 'application/pdf',
      status: 'draft',
      scanStatus: 'skipped',
    });
    expect(row.originalName).toBe('virus.exe'); // the name is kept for display; the rule used the content
    expect(row.ownerTeacherId).toBe(teacherId);
    expect(await ctx.get(FileStorage).getBytes(row.key)).toEqual(PDF);
    expect(await ctx.get(FileRepository).usedBytes(teacherId)).toBe(PDF.length);
    expect(await ctx.get(FileRepository).findCache(row.id, 'student')).toMatchObject({
      telegramFileId: 'pdf-1',
    });
    expect(await ctx.get(FileRepository).findCache(row.id, 'staff')).toBeNull();
  });

  it('refuses a disallowed type (HW-01) and a file over the limit, without touching the quota', async () => {
    const before = await ctx.get(FileRepository).usedBytes(teacherId);
    await expect(ingest(actor(studentId, 'STUDENT'), 'exe-1', 'game.pdf')).rejects.toMatchObject({
      code: 'FILE_TYPE_NOT_ALLOWED',
      details: { ext: 'exe' },
    });
    await expect(
      ingest(actor(studentId, 'STUDENT'), 'pdf-1', 'a.pdf', 50 * 1024 * 1024),
    ).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
    });
    expect(await ctx.get(FileRepository).usedBytes(teacherId)).toBe(before);
  });

  it('enforces the teacher quota (Р-27) for student uploads and reports it as STORAGE_QUOTA_EXCEEDED', async () => {
    const used = await ctx.get(FileRepository).usedBytes(teacherId);
    await ctx
      .get(FeatureAdminUseCase)
      .setTeacher(actor(adminId, 'ADMIN'), teacherId, 'storage', { limits: { quotaBytes: used + 100 } });
    await expect(ingest(actor(studentId, 'STUDENT'), 'big', 'big.pdf')).rejects.toMatchObject({
      code: 'STORAGE_QUOTA_EXCEEDED',
    });
    await ctx.get(FeatureAdminUseCase).resetTeacher(actor(adminId, 'ADMIN'), teacherId, 'storage');
  });

  it('HW-07: a student hits the hourly limit (every attempt counts); the teacher does not', async () => {
    const other = (await createAccount(tdb.txm, { roles: ['STUDENT'] })).id;
    await linkStudent(ctx, teacherId, other);
    for (let i = 0; i < UPLOADS_PER_HOUR - 1; i += 1) await ctx.get(UploadRateLimit).acquire(other);
    await expect(ingest(actor(other, 'STUDENT'), 'exe-1', 'x.pdf')).rejects.toMatchObject({
      code: 'FILE_TYPE_NOT_ALLOWED',
    });
    await expect(ingest(actor(other, 'STUDENT'), 'pdf-1', 'x.pdf')).rejects.toMatchObject({
      code: 'UPLOAD_RATE_LIMIT',
      details: { window: 'hour' },
    });
    for (let i = 0; i < UPLOADS_PER_HOUR; i += 1) await ctx.get(UploadRateLimit).acquire(teacherId);
    await expect(ingest(actor(teacherId, 'TEACHER'), 'pdf-1', 'notes.pdf')).resolves.toMatchObject({
      ext: 'pdf',
    });
  });

  it('8.0: a student without an active link cannot charge the teacher storage', async () => {
    const stranger = (await createAccount(tdb.txm, { roles: ['STUDENT'] })).id;
    await expect(ingest(actor(stranger, 'STUDENT'), 'pdf-1', 'x.pdf')).rejects.toMatchObject({
      code: 'LINK_NOT_ACTIVE',
    });
  });

  it('two uploads racing for the last bytes of the quota: exactly one wins, the loser leaves no object', async () => {
    const files = ctx.get(FileRepository);
    const used = await files.usedBytes(teacherId);
    await ctx.get(FeatureAdminUseCase).setTeacher(actor(adminId, 'ADMIN'), teacherId, 'storage', {
      limits: { quotaBytes: used + PDF.length + 10 },
    });
    const results = await Promise.allSettled([
      ingest(actor(studentId, 'STUDENT'), 'pdf-1', 'a.pdf'),
      ingest(actor(studentId, 'STUDENT'), 'pdf-1', 'b.pdf'),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok.length).toBe(1);
    expect(failed.length).toBe(1);
    expect((failed[0]!.reason as AppError).code).toBe('STORAGE_QUOTA_EXCEEDED');
    expect(await files.usedBytes(teacherId)).toBe(used + PDF.length);
    await ctx.get(FeatureAdminUseCase).resetTeacher(actor(adminId, 'ADMIN'), teacherId, 'storage');
  });

  it('delivers through another bot from S3 once, then from the cached file_id; albums cache every item', async () => {
    const files = ctx.get(FileRepository);
    const row = await ingest(actor(studentId, 'STUDENT'), 'pdf-1', 'hw.pdf');
    const sendDocument = vi.fn(async (_chat: number, doc: unknown) => ({
      message_id: 1,
      document: { file_id: typeof doc === 'string' ? doc : 'staff-fid-1', file_unique_id: 'su-1' },
    }));
    const sendMediaGroup = vi.fn(async (_chat: number, media: Array<{ media: unknown }>) =>
      media.map((m, i) => ({
        message_id: 10 + i,
        document: {
          file_id: typeof m.media === 'string' ? m.media : `parent-fid-${i}`,
          file_unique_id: `pu-${i}`,
        },
      })),
    );
    const staffApi = { sendDocument, sendMediaGroup } as unknown as Api;
    const delivery = ctx.get(FileDeliveryService);
    await delivery.send(staffApi, 'staff', 777, row);
    expect(sendDocument.mock.calls[0]![1]).not.toBe('pdf-1'); // uploaded as bytes, not the student bot's id
    expect(await files.findCache(row.id, 'staff')).toMatchObject({ telegramFileId: 'staff-fid-1' });
    await delivery.send(staffApi, 'staff', 777, row);
    expect(sendDocument.mock.calls[1]![1]).toBe('staff-fid-1');

    const second = await ingest(actor(studentId, 'STUDENT'), 'pdf-1', 'hw2.pdf');
    const report = await delivery.sendMany(staffApi, 'parent', 888, [row, second], 'Сдача');
    expect(report).toMatchObject({ sent: 2, skipped: [] });
    expect(sendMediaGroup).toHaveBeenCalledOnce();
    expect(await files.findCache(row.id, 'parent')).toMatchObject({ telegramFileId: 'parent-fid-0' });
    expect(await files.findCache(second.id, 'parent')).toMatchObject({ telegramFileId: 'parent-fid-1' });

    // eleven files → albums of 9 and 2 (never an album of one); a pending file is reported, not sent
    const many = [row, second];
    for (let i = 0; i < 9; i += 1) many.push(await ingest(actor(studentId, 'STUDENT'), 'pdf-1', `m${i}.pdf`));
    const pending = { ...many[0]!, id: many[0]!.id, scanStatus: 'pending' as const };
    sendMediaGroup.mockClear();
    const big = await delivery.sendMany(staffApi, 'parent', 888, [...many, pending]);
    expect(big.sent).toBe(11);
    expect(big.skipped.map((f) => f.scanStatus)).toEqual(['pending']);
    expect(sendMediaGroup.mock.calls.map((c) => c[1].length)).toEqual([9, 2]);
  });

  it('antivirus down → the file waits (`pending`, not delivered); the sweep scans it later (10.4)', async () => {
    const scanner = ctx.get<VirusScanner>(VirusScanner as unknown as symbol);
    const spy = vi
      .spyOn(scanner, 'scan')
      .mockResolvedValueOnce({ result: 'unavailable', detail: 'ECONNREFUSED' });
    const row = await ingest(actor(studentId, 'STUDENT'), 'pdf-1', 'wait.pdf');
    expect(row.scanStatus).toBe('pending');
    const delivery = ctx.get(FileDeliveryService);
    expect(() => delivery.assertDeliverable(row)).toThrow(AppError);
    // the scanner is the no-op one here: the sweep marks the file `skipped`
    await ctx.get(FileMaintenanceJob).rescan();
    expect((await ctx.get(FileRepository).findById(row.id))!.scanStatus).toBe('skipped');
    spy.mockRestore();
    const infected = vi.spyOn(scanner, 'scan').mockResolvedValueOnce({ result: 'infected', detail: 'Eicar' });
    await expect(ingest(actor(studentId, 'STUDENT'), 'pdf-1', 'eicar.pdf')).rejects.toMatchObject({
      code: 'FILE_REJECTED',
    });
    infected.mockRestore();
  });

  it('HW-06: draft files older than 24 h are purged from S3 and the quota is released; attached ones stay', async () => {
    const files = ctx.get(FileRepository);
    const storage = ctx.get(FileStorage);
    const kept = await ingest(actor(studentId, 'STUDENT'), 'pdf-1', 'kept.pdf');
    const orphan = await ingest(actor(studentId, 'STUDENT'), 'pdf-1', 'orphan.pdf');
    const foreignTeacher = (await createAccount(tdb.txm, { roles: ['TEACHER'] })).id;
    expect(await files.markAttached([kept.id], foreignTeacher, ctx.clock.now())).toEqual([]); // 8.0
    expect(await files.markAttached([kept.id], teacherId, ctx.clock.now())).toEqual([kept.id]);
    const before = await files.usedBytes(teacherId);
    ctx.clock.set(new Date(ctx.clock.now().getTime() + 25 * 60 * 60 * 1000).toISOString());
    const { purged } = await ctx.get(FileMaintenanceJob).run();
    expect(purged).toBeGreaterThanOrEqual(1);
    expect((await files.findById(orphan.id))!.status).toBe('deleted');
    expect((await files.findById(kept.id))!.status).toBe('attached');
    await expect(storage.getBytes(orphan.key)).rejects.toThrow();
    expect(await storage.getBytes(kept.key)).toEqual(PDF);
    expect(await files.usedBytes(teacherId)).toBeLessThan(before);
    // a purge that already ran cannot be undone by a late attach: zero rows attached, the caller must refuse
    expect(await files.markAttached([orphan.id], teacherId, ctx.clock.now())).toEqual([]);
  });
});
