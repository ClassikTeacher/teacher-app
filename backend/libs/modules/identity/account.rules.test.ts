import { describe, expect, it } from 'vitest';
import type { Actor } from '@modules/access/actor.js';
import { assertCanBlock, assertCanInvite, assertCanManageAdminRole } from './account.rules.js';
import type { AccountRow } from './schema.js';

const actor = (roles: Actor['roles'], accountId = 'a1'): Actor => ({
  accountId,
  roles,
  status: 'active',
  source: 'bot',
});
const target = (id = 't1'): AccountRow => ({ id }) as AccountRow;

describe('assertCanBlock (ACC-01, 3.2, 3.3)', () => {
  it('lets an admin block a teacher, student or parent', () => {
    expect(() => assertCanBlock(actor(['ADMIN']), target(), ['TEACHER'])).not.toThrow();
    expect(() => assertCanBlock(actor(['ADMIN']), target(), ['STUDENT', 'PARENT'])).not.toThrow();
  });

  it('never allows blocking the super admin', () => {
    expect(() => assertCanBlock(actor(['SUPER_ADMIN']), target(), ['SUPER_ADMIN', 'TEACHER'])).toThrow(
      /super admin/,
    );
  });

  it('reserves blocking admins to the super admin', () => {
    expect(() => assertCanBlock(actor(['ADMIN']), target(), ['ADMIN'])).toThrow(/Only the super admin/);
    expect(() => assertCanBlock(actor(['SUPER_ADMIN']), target(), ['ADMIN'])).not.toThrow();
  });

  it('forbids blocking yourself', () => {
    expect(() => assertCanBlock(actor(['ADMIN'], 't1'), target('t1'), ['TEACHER'])).toThrow(/yourself/);
  });
});

describe('assertCanInvite (INV-01)', () => {
  it('admin and super admin invite teachers', () => {
    expect(() => assertCanInvite(actor(['ADMIN']), 'TEACHER')).not.toThrow();
    expect(() => assertCanInvite(actor(['SUPER_ADMIN']), 'TEACHER')).not.toThrow();
    expect(() => assertCanInvite(actor(['TEACHER']), 'TEACHER')).toThrow(/Only admins/);
  });

  it('only the super admin invites admins', () => {
    expect(() => assertCanInvite(actor(['ADMIN']), 'ADMIN')).toThrow(/super admin/);
    expect(() => assertCanInvite(actor(['SUPER_ADMIN']), 'ADMIN')).not.toThrow();
  });

  it('other roles are not invitable through staff invitations', () => {
    expect(() => assertCanInvite(actor(['SUPER_ADMIN']), 'STUDENT')).toThrow(/not invitable/);
  });
});

describe('assertCanManageAdminRole (UC-03)', () => {
  it('only the super admin, and not on themselves', () => {
    expect(() => assertCanManageAdminRole(actor(['ADMIN']), 't1')).toThrow(/super admin/);
    expect(() => assertCanManageAdminRole(actor(['SUPER_ADMIN'], 'sa'), 'sa')).toThrow(/own admin role/);
    expect(() => assertCanManageAdminRole(actor(['SUPER_ADMIN'], 'sa'), 't1')).not.toThrow();
  });
});
