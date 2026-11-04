import { AppError } from '@shared/errors/app-error.js';
import { type Actor, isSuperAdmin, SYSTEM_ACTOR_ID } from '@modules/access/actor.js';
import type { AccountRow, AccountStatus, Role } from './schema.js';

/** The inviter must still be active and still allowed to hand out the role (checked again at redeem). */
export function inviterStillAuthorized(status: AccountStatus, roles: readonly Role[], role: Role): boolean {
  if (status !== 'active') return false;
  if (role === 'TEACHER') return roles.includes('ADMIN') || roles.includes('SUPER_ADMIN');
  if (role === 'ADMIN') return roles.includes('SUPER_ADMIN');
  return false;
}

/** Who may block whom (3.2, 3.3, ACC-01). Pure rule, unit-tested. */
export function assertCanBlock(actor: Actor, target: AccountRow, targetRoles: readonly Role[]): void {
  if (actor.accountId === target.id) throw new AppError('FORBIDDEN', 'You cannot block yourself');
  if (targetRoles.includes('SUPER_ADMIN')) {
    throw new AppError('FORBIDDEN', 'The super admin cannot be blocked through the interface');
  }
  if (targetRoles.includes('ADMIN') && !isSuperAdmin(actor)) {
    throw new AppError('FORBIDDEN', 'Only the super admin can block an admin');
  }
}

/** Grant/revoke of ADMIN is reserved to the super admin (UC-03); nobody manages SUPER_ADMIN here (5.3.4). */
export function assertCanManageAdminRole(actor: Actor, targetAccountId: string): void {
  if (!isSuperAdmin(actor)) throw new AppError('FORBIDDEN', 'Only the super admin manages admins');
  if (actor.accountId === targetAccountId && actor.accountId !== SYSTEM_ACTOR_ID) {
    throw new AppError('FORBIDDEN', 'The super admin cannot change their own admin role');
  }
}

/** Which staff role an inviter may hand out (INV-01). */
export function assertCanInvite(actor: Actor, role: Role): void {
  if (role === 'TEACHER') {
    if (!actor.roles.includes('ADMIN') && !isSuperAdmin(actor)) {
      throw new AppError('FORBIDDEN', 'Only admins invite teachers');
    }
    return;
  }
  if (role === 'ADMIN') {
    if (!isSuperAdmin(actor)) throw new AppError('FORBIDDEN', 'Only the super admin invites admins');
    return;
  }
  throw new AppError('VALIDATION_ERROR', `Role ${role} is not invitable`);
}
