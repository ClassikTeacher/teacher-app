import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount } from '@test/factories.js';
import { linkStudent, MATH_ID } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import type { Actor } from '@modules/access/actor.js';
import { FeatureAdminUseCase } from '@modules/access/features/feature-admin.use-case.js';
import { EndLinkUseCase } from '../links/end-link.use-case.js';
import { PeopleModule } from '../people.module.js';
import { GroupRepository } from './group.repository.js';
import { GroupsUseCase } from './groups.use-case.js';

describe('GroupsUseCase: limits, duplicates, membership races, feature flag', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let useCase: GroupsUseCase;
  let admin: Actor;
  const asTeacher = (id: string): Actor => ({
    accountId: id,
    roles: ['TEACHER'],
    status: 'active',
    source: 'bot',
  });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [PeopleModule, AccessModule]);
    useCase = ctx.get(GroupsUseCase);
    const a = await createAccount(tdb.txm, { roles: ['ADMIN'] });
    admin = { accountId: a.id, roles: ['ADMIN'], status: 'active', source: 'bot' };
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  it('parallel creation at the limit and a parallel duplicate name each leave exactly one group', async () => {
    const t = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    await ctx.get(FeatureAdminUseCase).setTeacher(admin, t.id, 'groups', { limits: { maxGroups: 1 } });
    const results = await Promise.allSettled([
      useCase.create(asTeacher(t.id), { name: 'A' }),
      useCase.create(asTeacher(t.id), { name: 'B' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await ctx.get(FeatureAdminUseCase).setTeacher(admin, t.id, 'groups', { limits: { maxGroups: null } });
    const dup = await Promise.allSettled([
      useCase.create(asTeacher(t.id), { name: 'Same' }),
      useCase.create(asTeacher(t.id), { name: 'same' }),
    ]);
    expect(dup.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = dup.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
    expect(failed.reason).toMatchObject({ code: 'CONFLICT', details: { reason: 'duplicate_name' } });
    expect(await ctx.get(GroupRepository).listByTeacher(t.id, { archived: false })).toHaveLength(2);
  });

  it('joining and ending the link at the same time never leaves an active membership on an ended link', async () => {
    const t = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    const s = await createAccount(tdb.txm, { roles: ['STUDENT'] });
    const link = await linkStudent(ctx, t.id, s.id);
    const group = await useCase.create(asTeacher(t.id), { name: 'Race' });
    const endLink = ctx.get(EndLinkUseCase);
    await Promise.allSettled([
      useCase.addMember(asTeacher(t.id), group.id, s.id),
      endLink.execute(asTeacher(t.id), link.id, { reason: 'removed_by_teacher', message: 'bye' }),
    ]);
    expect(await ctx.get(GroupRepository).listMembers(group.id)).toHaveLength(0);
    await expect(useCase.addMember(asTeacher(t.id), group.id, s.id)).rejects.toMatchObject({
      code: 'LINK_NOT_ACTIVE',
    });
  });

  it('double add and double remove are CONFLICT; the transaction survives the unique violation', async () => {
    const t = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    const s = await createAccount(tdb.txm, { roles: ['STUDENT'] });
    await linkStudent(ctx, t.id, s.id, { subjectIds: [MATH_ID] });
    const group = await useCase.create(asTeacher(t.id), { name: 'Twice' });
    await useCase.addMember(asTeacher(t.id), group.id, s.id);
    await expect(useCase.addMember(asTeacher(t.id), group.id, s.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await useCase.removeMember(asTeacher(t.id), group.id, s.id);
    await expect(useCase.removeMember(asTeacher(t.id), group.id, s.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await useCase.addMember(asTeacher(t.id), group.id, s.id); // the connection is still usable
    expect(await ctx.get(GroupRepository).listMembers(group.id)).toHaveLength(1);
  });

  it('a disabled groups feature blocks mutations but not archiving', async () => {
    const t = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    const group = await useCase.create(asTeacher(t.id), { name: 'Off' });
    await ctx.get(FeatureAdminUseCase).setTeacher(admin, t.id, 'groups', { enabled: false });
    await expect(useCase.create(asTeacher(t.id), { name: 'New' })).rejects.toMatchObject({
      code: 'FEATURE_DISABLED',
    });
    await expect(useCase.update(asTeacher(t.id), group.id, { name: 'Renamed' })).rejects.toMatchObject({
      code: 'FEATURE_DISABLED',
    });
    expect((await useCase.archive(asTeacher(t.id), group.id)).archivedAt).not.toBeNull();
  });
});
