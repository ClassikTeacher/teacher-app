import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount } from '@test/factories.js';
import type { Actor } from '../actor.js';
import { AccessModule } from '../access.module.js';
import { FeatureAdminUseCase } from './feature-admin.use-case.js';
import { FeatureService } from './feature.service.js';

describe('FeatureService: cache, invalidation, guards (5.3.3)', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let admin: Actor;
  let teacherId: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [AccessModule]);
    const adminRow = await createAccount(tdb.txm, { roles: ['ADMIN'] });
    admin = { accountId: adminRow.id, roles: ['ADMIN'], status: 'active', source: 'api' };
    teacherId = (await createAccount(tdb.txm, { roles: ['TEACHER'] })).id;
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('serves defaults, caches, and drops the cache after a personal change', async () => {
    const features = ctx.get(FeatureService);
    expect(await features.isEnabled(teacherId, 'homework')).toBe(true);
    await ctx.get(FeatureAdminUseCase).setTeacher(admin, teacherId, 'homework', { enabled: false });
    expect(await features.isEnabled(teacherId, 'homework')).toBe(false);
    await expect(features.assertEnabled(teacherId, 'homework.submissions')).rejects.toMatchObject({
      code: 'FEATURE_DISABLED',
      details: { feature: 'homework.submissions' },
    });
  });

  it('a global switch invalidates every teacher at once and wins over personal overrides', async () => {
    const features = ctx.get(FeatureService);
    const other = (await createAccount(tdb.txm, { roles: ['TEACHER'] })).id;
    expect(await features.isEnabled(other, 'reports')).toBe(true);
    await ctx.get(FeatureAdminUseCase).setGlobal(admin, 'reports', { globalEnabled: false });
    expect(await features.isEnabled(other, 'reports')).toBe(false);
    expect((await features.resolve(other)).get('reports')?.reason).toBe('global');
    await ctx.get(FeatureAdminUseCase).setGlobal(admin, 'reports', { globalEnabled: true });
    expect(await features.isEnabled(other, 'reports')).toBe(true);
  });

  it('rejects non-teachers, unknown keys, bad limits, switching core off and non-admins', async () => {
    const uc = ctx.get(FeatureAdminUseCase);
    const student = (await createAccount(tdb.txm, { roles: ['STUDENT'] })).id;
    await expect(uc.setTeacher(admin, student, 'homework', { enabled: false })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(uc.setTeacher(admin, teacherId, 'nope', { enabled: false })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      uc.setTeacher(admin, teacherId, 'storage', { limits: { quotaBytes: -1 } }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(uc.setGlobal(admin, 'core', { globalEnabled: false })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    const teacherActor: Actor = { accountId: teacherId, roles: ['TEACHER'], status: 'active', source: 'bot' };
    await expect(uc.setGlobal(teacherActor, 'homework', { globalEnabled: false })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
