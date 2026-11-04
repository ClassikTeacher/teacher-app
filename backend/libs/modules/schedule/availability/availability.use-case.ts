import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { type Actor, assertRole, primaryRole } from '@modules/access/actor.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import {
  type AvailabilityExceptionRow,
  type AvailabilityRuleRow,
  EXCEPTION_KINDS,
  type ExceptionKind,
} from '../schema.js';
import { AvailabilityRepository } from './availability.repository.js';
import { MINUTES_PER_DAY, minutesToTime } from './windows.js';

export const MAX_RULES_PER_TEACHER = 50;
export const MAX_EXCEPTIONS_PER_TEACHER = 200;
/** Exceptions are listed this many days ahead in the settings screen. */
export const EXCEPTIONS_LOOKAHEAD_DAYS = 90;

export interface RuleInput {
  weekdays: readonly number[];
  startMin: number;
  endMin: number;
  validFrom?: string | null;
  validTo?: string | null;
}

export interface ExceptionInput {
  date: string;
  kind: ExceptionKind;
  /** Omit both for a whole closed day. */
  startMin?: number | null;
  endMin?: number | null;
}

const isIsoDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && DateTime.fromISO(v).isValid;

function assertSpan(startMin: number, endMin: number): void {
  const ok = (v: number): boolean => Number.isInteger(v) && v >= 0 && v <= MINUTES_PER_DAY;
  if (!ok(startMin) || !ok(endMin) || endMin <= startMin)
    throw AppError.validation('Window end must be after its start, within one day');
}

/** 5.5.4 settings: weekly rules and date exceptions of the teacher; pure CRUD with audit. */
@Injectable()
export class AvailabilityUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly repo: AvailabilityRepository,
    private readonly accounts: AccountRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async listRules(actor: Actor): Promise<AvailabilityRuleRow[]> {
    assertRole(actor, 'TEACHER');
    return this.repo.listRules(actor.accountId);
  }

  async listUpcomingExceptions(actor: Actor, zone: string): Promise<AvailabilityExceptionRow[]> {
    assertRole(actor, 'TEACHER');
    const today = DateTime.fromJSDate(this.clock.now(), { zone }).startOf('day');
    return this.repo.listExceptions(
      actor.accountId,
      today.toISODate()!,
      today.plus({ days: EXCEPTIONS_LOOKAHEAD_DAYS }).toISODate()!,
    );
  }

  /** One rule per chosen weekday; overlapping rules on a day are merged at read time, not refused. */
  async addRule(actor: Actor, input: RuleInput): Promise<AvailabilityRuleRow[]> {
    assertRole(actor, 'TEACHER');
    const weekdays = [...new Set(input.weekdays)];
    if (weekdays.length === 0 || weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7))
      throw AppError.validation('Choose at least one weekday (1–7)');
    assertSpan(input.startMin, input.endMin);
    const validFrom = input.validFrom ?? null;
    const validTo = input.validTo ?? null;
    if ((validFrom && !isIsoDate(validFrom)) || (validTo && !isIsoDate(validTo)))
      throw AppError.validation('Validity dates must be ISO dates');
    if (validFrom && validTo && validTo < validFrom) throw AppError.validation('validTo is before validFrom');
    return this.txm.run(async () => {
      const existing = await this.repo.listRules(actor.accountId);
      if (existing.length + weekdays.length > MAX_RULES_PER_TEACHER)
        throw new AppError('LIMIT_EXCEEDED', 'Too many availability rules', { max: MAX_RULES_PER_TEACHER });
      const rows = await this.repo.insertRules(
        weekdays.map((weekday) => ({
          teacherId: actor.accountId,
          weekday,
          startLocal: minutesToTime(input.startMin),
          endLocal: minutesToTime(input.endMin),
          validFrom,
          validTo,
        })),
      );
      await this.record(actor, 'availability.rule_added', null, {
        weekdays,
        start: minutesToTime(input.startMin),
        end: minutesToTime(input.endMin),
        validFrom,
        validTo,
      });
      return rows;
    });
  }

  async removeRule(actor: Actor, ruleId: string): Promise<void> {
    assertRole(actor, 'TEACHER');
    await this.txm.run(async () => {
      const rule = await this.repo.findRule(ruleId);
      if (!rule || rule.teacherId !== actor.accountId) throw AppError.notFound('availability rule', ruleId);
      if (!(await this.repo.removeRule(rule.id, this.clock.now())))
        throw new AppError('CONFLICT', 'Rule is already removed');
      await this.record(actor, 'availability.rule_removed', rule.id, {
        weekday: rule.weekday,
        start: rule.startLocal,
        end: rule.endLocal,
      });
    });
  }

  /** A closed day/interval or an extra window; duplicates are returned as is, past dates are refused. */
  async addException(actor: Actor, input: ExceptionInput): Promise<AvailabilityExceptionRow> {
    assertRole(actor, 'TEACHER');
    if (!isIsoDate(input.date)) throw AppError.validation('date must be an ISO date');
    if (!EXCEPTION_KINDS.includes(input.kind)) throw AppError.validation('Unknown exception kind');
    const startGiven = input.startMin !== undefined && input.startMin !== null;
    const endGiven = input.endMin !== undefined && input.endMin !== null;
    if (startGiven !== endGiven) throw AppError.validation('Both start and end are required for an interval');
    const whole = !startGiven;
    if (whole && input.kind === 'extra') throw AppError.validation('An extra window needs a time span');
    if (!whole) assertSpan(input.startMin!, input.endMin!);
    const zone = (await this.accounts.findById(actor.accountId))?.timezone ?? 'UTC';
    const today = DateTime.fromJSDate(this.clock.now(), { zone }).toISODate()!;
    if (input.date < today) throw AppError.validation('The date is in the past', { reason: 'past' });
    return this.txm.run(async () => {
      const existing = await this.repo.listExceptions(actor.accountId, input.date, input.date);
      const startLocal = whole ? null : minutesToTime(input.startMin!);
      const endLocal = whole ? null : minutesToTime(input.endMin!);
      const same = existing.find(
        (e) => e.kind === input.kind && e.startLocal === startLocal && e.endLocal === endLocal,
      );
      if (same) return same; // a double tap or a repeated request changes nothing
      const total = await this.repo.listExceptions(actor.accountId, today, '9999-12-31');
      if (total.length >= MAX_EXCEPTIONS_PER_TEACHER)
        throw new AppError('LIMIT_EXCEEDED', 'Too many exceptions', { max: MAX_EXCEPTIONS_PER_TEACHER });
      const row = await this.repo.insertException({
        teacherId: actor.accountId,
        date: input.date,
        kind: input.kind,
        startLocal,
        endLocal,
      });
      await this.record(actor, 'availability.exception_added', row.id, {
        date: row.date,
        kind: row.kind,
        start: row.startLocal,
        end: row.endLocal,
      });
      return row;
    });
  }

  async removeException(actor: Actor, exceptionId: string): Promise<void> {
    assertRole(actor, 'TEACHER');
    await this.txm.run(async () => {
      const row = await this.repo.findException(exceptionId);
      if (!row || row.teacherId !== actor.accountId)
        throw AppError.notFound('availability exception', exceptionId);
      if (!(await this.repo.removeException(row.id, this.clock.now())))
        throw new AppError('CONFLICT', 'Exception is already removed');
      await this.record(actor, 'availability.exception_removed', row.id, { date: row.date, kind: row.kind });
    });
  }

  private record(
    actor: Actor,
    action: string,
    entityId: string | null,
    after: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record({
      actorId: actor.accountId,
      actorRole: primaryRole(actor),
      action,
      entityType: 'availability',
      entityId,
      after,
      source: actor.source,
      ip: actor.ip,
    });
  }
}
