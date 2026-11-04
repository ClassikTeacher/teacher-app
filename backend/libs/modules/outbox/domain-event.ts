/**
 * Domain events crossing module boundaries. Written to the outbox in the producing transaction (7.5)
 * and delivered by the worker (M1-07). Keep payloads small and free of personal data beyond ids.
 */
export interface DomainEvent<
  TType extends string = string,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  type: TType;
  aggregateType: string;
  aggregateId: string | null;
  payload: TPayload;
}

export type AccountBlockedEvent = DomainEvent<
  'account.blocked',
  {
    accountId: string;
    roles: string[];
    lessonsPolicy: 'cancel' | 'keep';
    message: string | null;
    byAccountId: string;
  }
>;
export type AccountUnblockedEvent = DomainEvent<
  'account.unblocked',
  { accountId: string; byAccountId: string }
>;
export type TeacherOnboardedEvent = DomainEvent<
  'teacher.onboarded',
  { accountId: string; invitedBy: string | null }
>;
export type InvitationExpiredEvent = DomainEvent<
  'invitation.expired',
  { invitationId: string; kind: string; createdBy: string | null }
>;
export type RoleGrantedEvent = DomainEvent<
  'role.granted',
  { accountId: string; role: string; byAccountId: string | null }
>;
export type RoleRevokedEvent = DomainEvent<
  'role.revoked',
  { accountId: string; role: string; byAccountId: string | null }
>;
