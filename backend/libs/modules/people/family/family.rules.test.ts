import { describe, expect, it } from 'vitest';
import type { Actor } from '@modules/access/actor.js';
import type { FamilyLinkRow } from '../schema.js';
import { familyRevokerRole } from './revoke-family-link.use-case.js';

const actor = (accountId: string, roles: Actor['roles']): Actor => ({
  accountId,
  roles,
  status: 'active',
  source: 'bot',
});
const link = (overrides: Partial<FamilyLinkRow> = {}): FamilyLinkRow => ({
  id: 'l',
  parentId: 'parent',
  studentId: 'student',
  status: 'active',
  invitedBy: 'teacher',
  invitationId: null,
  confirmedAt: new Date(),
  revokedAt: null,
  revokedBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('familyRevokerRole (5.4.3, 3.8)', () => {
  it('lets the parent, the inviting teacher and admins revoke', () => {
    expect(familyRevokerRole(actor('parent', ['PARENT']), link())).toBe('parent');
    expect(familyRevokerRole(actor('teacher', ['TEACHER']), link())).toBe('teacher');
    expect(familyRevokerRole(actor('admin', ['ADMIN']), link())).toBe('admin');
    expect(familyRevokerRole(actor('sa', ['SUPER_ADMIN']), link())).toBe('admin');
  });

  it('refuses the student, another teacher and a teacher who lost the role', () => {
    expect(() => familyRevokerRole(actor('student', ['STUDENT']), link())).toThrow(/Only the parent/);
    expect(() => familyRevokerRole(actor('other', ['TEACHER']), link())).toThrow(/Only the parent/);
    expect(() => familyRevokerRole(actor('teacher', ['STUDENT']), link())).toThrow(/Only the parent/);
    expect(() => familyRevokerRole(actor('teacher', ['TEACHER']), link({ invitedBy: null }))).toThrow(
      /Only the parent/,
    );
  });

  it('an admin who also invited the link is recorded as the parent-side actor only when they are the parent', () => {
    expect(familyRevokerRole(actor('teacher', ['ADMIN', 'TEACHER']), link())).toBe('admin');
    expect(familyRevokerRole(actor('parent', ['ADMIN', 'PARENT']), link())).toBe('parent');
  });
});
