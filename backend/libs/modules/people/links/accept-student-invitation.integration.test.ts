import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '@shared/errors/app-error.js';
import { createTestContext, type TestContext } from '@test/app.js';
import { createTestDatabase, type TestDatabase } from '@test/db.js';
import { createAccount, nextTelegramUserId } from '@test/factories.js';
import { issueStudentInvitation } from '@test/people.js';
import { AccessModule } from '@modules/access/access.module.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { PeopleModule } from '../people.module.js';
import { AcceptStudentInvitationUseCase } from './accept-student-invitation.use-case.js';
import { TeacherStudentRepository } from './teacher-student.repository.js';

describe('AcceptStudentInvitationUseCase: races and inviter authority', () => {
  let tdb: TestDatabase;
  let ctx: TestContext;
  let useCase: AcceptStudentInvitationUseCase;
  let teacherId: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ctx = await createTestContext(tdb, [PeopleModule, AccessModule]);
    useCase = ctx.get(AcceptStudentInvitationUseCase);
    teacherId = (await createAccount(tdb.txm, { roles: ['TEACHER'] })).id;
  });
  afterAll(async () => {
    await ctx.close();
    await tdb.drop();
  });

  const questionnaire = {
    firstName: 'Петя',
    lastName: '',
    timezone: 'Europe/Minsk',
    consentVersion: '2026-10-19-draft',
  };

  it('two invitations of the same teacher accepted at once by one person end as one link and one CONFLICT', async () => {
    const [a, b] = await Promise.all([
      issueStudentInvitation(ctx, teacherId),
      issueStudentInvitation(ctx, teacherId),
    ]);
    const user = { id: nextTelegramUserId(), firstName: 'Петя' };
    const results = await Promise.allSettled([
      useCase.accept({ user, token: a.token, chatId: user.id, questionnaire }),
      useCase.accept({ user, token: b.token, chatId: user.id, questionnaire }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(AppError.is(failed[0]!.reason, 'CONFLICT')).toBe(true);
    const account = (await ctx.get(AccountRepository).findByTelegramUserId(user.id))!;
    const links = await ctx.get(TeacherStudentRepository).listByStudent(account.id, ['active']);
    expect(links).toHaveLength(1);
  });

  it('the same link accepted twice in parallel succeeds exactly once', async () => {
    const { token } = await issueStudentInvitation(ctx, teacherId);
    const user = { id: nextTelegramUserId(), firstName: 'Вася' };
    const results = await Promise.allSettled([
      useCase.accept({ user, token, chatId: user.id, questionnaire }),
      useCase.accept({ user, token, chatId: user.id, questionnaire }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
    expect(AppError.is(failed.reason)).toBe(true);
    expect(['INVITATION_INVALID', 'CONFLICT']).toContain((failed.reason as AppError).code);
  });

  it('a blocked teacher invalidates their links (INV-01 at redeem time)', async () => {
    const blocked = await createAccount(tdb.txm, { roles: ['TEACHER'] });
    const { token } = await issueStudentInvitation(ctx, blocked.id);
    await ctx.get(AccountRepository).update(blocked.id, { status: 'blocked' });
    const user = { id: nextTelegramUserId(), firstName: 'Коля' };
    await expect(useCase.accept({ user, token, chatId: user.id, questionnaire })).rejects.toMatchObject({
      code: 'INVITATION_INVALID',
    });
  });

  it('a link bound to another Telegram user is refused (INV-03)', async () => {
    const { token } = await issueStudentInvitation(ctx, teacherId);
    // bind the pending invitation to someone else
    const { invitation } = await import('@modules/identity/schema.js');
    const { eq } = await import('drizzle-orm');
    const { hashInvitationToken } = await import('@modules/identity/invitation.rules.js');
    await tdb.db
      .update(invitation)
      .set({ targetTelegramUserId: 1 })
      .where(eq(invitation.tokenHash, hashInvitationToken(token)));
    const user = { id: nextTelegramUserId(), firstName: 'Чужой' };
    await expect(useCase.accept({ user, token, chatId: user.id, questionnaire })).rejects.toMatchObject({
      code: 'INVITATION_NOT_FOR_YOU',
    });
  });
});
