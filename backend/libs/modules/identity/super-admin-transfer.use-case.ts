import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '@shared/db/drizzle.js';
import { AppError } from '@shared/errors/app-error.js';
import { newId } from '@shared/ids/index.js';
import { addHours, Clock } from '@shared/time/clock.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { AccountRepository } from './account.repository.js';
import { superAdminTransfer, type SuperAdminTransferRow, type TransferStatus } from './schema.js';
import { superAdminAccountId } from './super-admin.query.js';

export const TRANSFER_TTL_HOURS = 24;

export interface TransferRequest {
  toAccountId: string;
  /** What the current super admin becomes (5.3.4). */
  previousRole: 'ADMIN' | 'NONE';
  ip?: string | null;
}

type Decision = 'confirmed' | 'declined';

/**
 * UC-02: the only way to change the super admin. Requested with the system key, confirmed by the new SA in
 * AuthBot; the role moves in one transaction (revoke first, then grant — the single-SA index is not deferrable).
 */
@Injectable()
export class SuperAdminTransferUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly accounts: AccountRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  async request(input: TransferRequest): Promise<SuperAdminTransferRow> {
    const now = this.clock.now();
    return this.txm.run(async () => {
      const fromId = await superAdminAccountId(this.txm.db);
      if (!fromId) throw new AppError('CONFLICT', 'No super admin exists; run seed:superadmin');
      if (fromId === input.toAccountId) throw new AppError('CONFLICT', 'Account is already the super admin');
      const target = await this.accounts.findById(input.toAccountId);
      if (!target) throw AppError.notFound('account', input.toAccountId);
      const roles = await this.accounts.activeRoles(target.id);
      if (target.status !== 'active' || !roles.some((r) => r === 'ADMIN' || r === 'TEACHER')) {
        throw new AppError('CONFLICT', 'The new super admin must be an active staff account');
      }
      const pending = await this.findPending();
      if (pending && pending.expiresAt.getTime() <= now.getTime())
        await this.setStatus(pending.id, 'expired', now);
      else if (pending)
        throw new AppError('CONFLICT', 'A transfer is already pending', { transferId: pending.id });

      const [row] = await this.txm
        .runSavepoint(() =>
          this.txm.db
            .insert(superAdminTransfer)
            .values({
              id: newId(),
              fromAccountId: fromId,
              toAccountId: target.id,
              previousRole: input.previousRole,
              expiresAt: addHours(now, TRANSFER_TTL_HOURS),
            })
            .returning(),
        )
        .catch((error: unknown) => {
          if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
            throw new AppError('CONFLICT', 'A transfer is already pending');
          throw error;
        });
      await this.audit.record({
        actorId: null,
        actorRole: 'SYSTEM',
        action: 'superadmin.transfer_requested',
        entityType: 'super_admin_transfer',
        entityId: row!.id,
        after: { from: fromId, to: target.id, previousRole: input.previousRole },
        source: 'api',
        ip: input.ip ?? null,
      });
      await this.outbox.publish({
        type: 'superadmin.transfer_requested',
        aggregateType: 'super_admin_transfer',
        aggregateId: row!.id,
        payload: {
          transferId: row!.id,
          fromAccountId: fromId,
          toAccountId: target.id,
          expiresAt: row!.expiresAt.toISOString(),
        },
      });
      return row!;
    });
  }

  async confirm(transferId: string, byAccountId: string): Promise<SuperAdminTransferRow> {
    return this.decide(transferId, byAccountId, 'confirmed');
  }

  /** The system API (or the current SA) withdraws a pending transfer; both parties are told. */
  async cancel(
    transferId: string,
    input: { byAccountId: string | null; ip?: string | null },
  ): Promise<SuperAdminTransferRow> {
    const now = this.clock.now();
    return this.txm.run(async () => {
      const [row] = await this.txm.db
        .select()
        .from(superAdminTransfer)
        .where(eq(superAdminTransfer.id, transferId))
        .for('update');
      if (!row) throw AppError.notFound('transfer', transferId);
      if (row.status !== 'pending') throw new AppError('CONFLICT', `Transfer is ${row.status}`);
      const updated = await this.setStatus(row.id, 'cancelled', now);
      await this.audit.record({
        actorId: input.byAccountId,
        actorRole: input.byAccountId ? 'SUPER_ADMIN' : 'SYSTEM',
        action: 'superadmin.transfer_cancelled',
        entityType: 'super_admin_transfer',
        entityId: row.id,
        source: input.byAccountId ? 'bot' : 'api',
        ip: input.ip ?? null,
      });
      await this.outbox.publish({
        type: 'superadmin.transfer_cancelled',
        aggregateType: 'super_admin_transfer',
        aggregateId: row.id,
        payload: { transferId: row.id, fromAccountId: row.fromAccountId, toAccountId: row.toAccountId },
      });
      return updated;
    });
  }

  /** Marks the transfer expired in its own transaction (a later throw must not roll this back). */
  private async expireIfDue(transferId: string, now: Date): Promise<boolean> {
    return this.txm.run(async () => {
      const [row] = await this.txm.db
        .select()
        .from(superAdminTransfer)
        .where(eq(superAdminTransfer.id, transferId))
        .for('update');
      if (!row || row.status !== 'pending' || row.expiresAt.getTime() > now.getTime()) return false;
      await this.setStatus(row.id, 'expired', now);
      await this.audit.record({
        actorId: null,
        actorRole: 'SYSTEM',
        action: 'superadmin.transfer_expired',
        entityType: 'super_admin_transfer',
        entityId: row.id,
        source: 'system',
      });
      return true;
    });
  }

  async decline(transferId: string, byAccountId: string): Promise<SuperAdminTransferRow> {
    return this.decide(transferId, byAccountId, 'declined');
  }

  /** The pending transfer addressed to this account, if any and not expired. */
  async findPendingFor(accountId: string): Promise<SuperAdminTransferRow | null> {
    const pending = await this.findPending();
    if (!pending || pending.toAccountId !== accountId) return null;
    return pending.expiresAt.getTime() <= this.clock.now().getTime() ? null : pending;
  }

  private async decide(
    transferId: string,
    byAccountId: string,
    decision: Decision,
  ): Promise<SuperAdminTransferRow> {
    const now = this.clock.now();
    if (await this.expireIfDue(transferId, now)) throw new AppError('CONFLICT', 'Transfer has expired');
    return this.txm.run(async () => {
      const [row] = await this.txm.db
        .select()
        .from(superAdminTransfer)
        .where(eq(superAdminTransfer.id, transferId))
        .for('update');
      if (!row) throw AppError.notFound('transfer', transferId);
      if (row.toAccountId !== byAccountId) throw AppError.forbidden('Only the designated account can decide');
      if (row.status !== 'pending') throw new AppError('CONFLICT', `Transfer is ${row.status}`);
      const target = await this.accounts.findById(row.toAccountId);
      const targetRoles = target ? await this.accounts.activeRoles(target.id) : [];
      if (decision === 'confirmed') {
        // Re-validated at decision time (5.3.4): the target may have been blocked or stripped of staff roles.
        if (
          !target ||
          target.status !== 'active' ||
          !targetRoles.some((r) => r === 'ADMIN' || r === 'TEACHER')
        ) {
          throw new AppError('CONFLICT', 'The new super admin must be an active staff account');
        }
        if ((await superAdminAccountId(this.txm.db)) !== row.fromAccountId) {
          throw new AppError('CONFLICT', 'The super admin changed meanwhile');
        }
        await this.accounts.revokeRole(row.fromAccountId, 'SUPER_ADMIN', row.toAccountId);
        const oldRoles = await this.accounts.activeRoles(row.fromAccountId);
        if (row.previousRole === 'ADMIN' && !oldRoles.includes('ADMIN')) {
          await this.accounts.grantRole(row.fromAccountId, 'ADMIN', row.toAccountId);
        }
        await this.accounts.grantRole(row.toAccountId, 'SUPER_ADMIN', row.toAccountId);
      }
      const updated = await this.setStatus(row.id, decision, now);
      await this.audit.record({
        actorId: byAccountId,
        actorRole: decision === 'confirmed' ? 'SUPER_ADMIN' : (targetRoles[0] ?? null),
        action: `superadmin.transfer_${decision}`,
        entityType: 'super_admin_transfer',
        entityId: row.id,
        before: { superAdmin: row.fromAccountId },
        after:
          decision === 'confirmed'
            ? { superAdmin: row.toAccountId, previousRole: row.previousRole }
            : { status: decision },
        source: 'bot',
      });
      await this.outbox.publish({
        type: `superadmin.transfer_${decision}`,
        aggregateType: 'super_admin_transfer',
        aggregateId: row.id,
        payload: { transferId: row.id, fromAccountId: row.fromAccountId, toAccountId: row.toAccountId },
      });
      return updated;
    });
  }

  private async findPending(): Promise<SuperAdminTransferRow | null> {
    const rows = await this.txm.db
      .select()
      .from(superAdminTransfer)
      .where(eq(superAdminTransfer.status, 'pending'))
      .limit(1);
    return rows[0] ?? null;
  }

  private async setStatus(id: string, status: TransferStatus, now: Date): Promise<SuperAdminTransferRow> {
    const [row] = await this.txm.db
      .update(superAdminTransfer)
      .set({ status, decidedAt: now })
      .where(and(eq(superAdminTransfer.id, id), eq(superAdminTransfer.status, 'pending')))
      .returning();
    if (!row) throw new AppError('CONFLICT', 'Transfer is no longer pending');
    return row;
  }
}
