import { AppError } from '@shared/errors/app-error.js';
import type { AccountStatus, Role } from '@modules/identity/schema.js';

export type ActorSource = 'bot' | 'web' | 'api' | 'system';

/** Who performs a use-case. Resolved from the Telegram user (bots) or the bearer token (REST). */
export interface Actor {
  accountId: string;
  roles: readonly Role[];
  status: AccountStatus;
  source: ActorSource;
  /** Client address for audit (REST only, after TRUST_PROXY_HOPS). */
  ip?: string | null;
}

export const SYSTEM_ACTOR_ID = '00000000-0000-7000-8000-000000000000';

export const SYSTEM_ACTOR: Actor = {
  accountId: SYSTEM_ACTOR_ID,
  roles: ['SUPER_ADMIN'],
  status: 'active',
  source: 'system',
};

export function hasRole(actor: Actor, ...roles: Role[]): boolean {
  return roles.some((r) => actor.roles.includes(r));
}

export function isSuperAdmin(actor: Actor): boolean {
  return actor.roles.includes('SUPER_ADMIN');
}

/** Admin-level access: ADMIN or SUPER_ADMIN (3.3). */
export function isAdmin(actor: Actor): boolean {
  return hasRole(actor, 'ADMIN', 'SUPER_ADMIN');
}

export function isStaff(actor: Actor): boolean {
  return hasRole(actor, 'ADMIN', 'SUPER_ADMIN', 'TEACHER');
}

/** Primary role for audit records: the most privileged one. */
export function primaryRole(actor: Actor): Role | null {
  const order: Role[] = ['SUPER_ADMIN', 'ADMIN', 'TEACHER', 'PARENT', 'STUDENT'];
  return order.find((r) => actor.roles.includes(r)) ?? null;
}

export function assertActive(actor: Actor): void {
  if (actor.status === 'blocked') throw new AppError('ACCOUNT_BLOCKED', 'Account is blocked');
  if (actor.status !== 'active' && actor.source !== 'system') {
    throw new AppError('FORBIDDEN', 'Onboarding is not completed');
  }
}

export function assertRole(actor: Actor, ...roles: Role[]): void {
  assertActive(actor);
  if (!hasRole(actor, ...roles)) {
    throw new AppError('FORBIDDEN', 'Insufficient role', { required: roles });
  }
}

export function assertAdmin(actor: Actor): void {
  assertRole(actor, 'ADMIN', 'SUPER_ADMIN');
}

export function assertSuperAdmin(actor: Actor): void {
  assertRole(actor, 'SUPER_ADMIN');
}
