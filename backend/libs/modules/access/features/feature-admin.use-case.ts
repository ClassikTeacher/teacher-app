import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { type Actor, assertAdmin, primaryRole } from '../actor.js';
import {
  FEATURE_BY_KEY,
  type FeatureDefinition,
  type FeatureKey,
  type FeatureLimits,
  limitNames,
} from './catalog.js';
import { FeatureRepository, type GlobalPatch, type PersonalPatch } from './feature.repository.js';
import { FeatureService } from './feature.service.js';
import { dependantsOf, type ResolvedFeatures } from './rules.js';

export type GlobalFeaturePatch = GlobalPatch;
export type TeacherFeaturePatch = PersonalPatch;

function definitionOf(key: string): FeatureDefinition {
  const definition = FEATURE_BY_KEY.get(key as FeatureKey);
  if (!definition) throw AppError.notFound('feature', key);
  return definition;
}

/** Limits must belong to the feature and be non-negative numbers or null (unlimited). */
function assertLimits(definition: FeatureDefinition, limits: FeatureLimits | null | undefined): void {
  const allowed = limitNames(definition);
  for (const [name, value] of Object.entries(limits ?? {})) {
    if (!allowed.includes(name)) throw AppError.validation(`Unknown limit ${name} for ${definition.key}`);
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      throw AppError.validation(`Limit ${name} must be a non-negative number or null`);
    }
  }
}

function sameLimits(a: FeatureLimits | null | undefined, b: FeatureLimits | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** UC-07 and the platform defaults (5.3.1–5.3.3): validated, audited, event-sourced, cache dropped after commit. */
@Injectable()
export class FeatureAdminUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly repo: FeatureRepository,
    private readonly features: FeatureService,
    private readonly accounts: AccountRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  validateGlobal(rawKey: string, patch: GlobalPatch): FeatureDefinition {
    const definition = definitionOf(rawKey);
    if (!definition.toggleable && (patch.globalEnabled === false || patch.defaultEnabled === false)) {
      throw AppError.validation('Core cannot be switched off');
    }
    assertLimits(definition, patch.defaultLimits);
    return definition;
  }

  validateTeacher(rawKey: string, patch: PersonalPatch): FeatureDefinition {
    const definition = definitionOf(rawKey);
    if (!definition.toggleable && patch.enabled === false)
      throw AppError.validation('Core cannot be switched off');
    assertLimits(definition, patch.limits);
    return definition;
  }

  async setGlobal(actor: Actor, rawKey: string, patch: GlobalPatch): Promise<void> {
    assertAdmin(actor);
    const { key } = this.validateGlobal(rawKey, patch);
    await this.txm.run(async () => {
      const before = (await this.features.computeGlobal()).get(key)!;
      const row = await this.repo.upsertGlobal(key, patch, actor.accountId);
      const after = (await this.features.computeGlobal()).get(key)!;
      const unchanged =
        before.globalEnabled === row.globalEnabled &&
        before.defaultEnabled === row.defaultEnabled &&
        sameLimits(before.limits, after.limits);
      if (unchanged) return;
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: primaryRole(actor),
        action: 'feature.global_changed',
        entityType: 'feature',
        before: {
          key,
          globalEnabled: before.globalEnabled,
          defaultEnabled: before.defaultEnabled,
          defaultLimits: before.limits,
        },
        after: {
          key,
          globalEnabled: row.globalEnabled,
          defaultEnabled: row.defaultEnabled,
          defaultLimits: after.limits,
        },
        source: actor.source,
        ip: actor.ip,
      });
      await this.outbox.publish({
        type: 'feature.global_changed',
        aggregateType: 'feature',
        aggregateId: null,
        payload: {
          feature: key,
          affected: [key, ...dependantsOf(key)],
          globalEnabled: row.globalEnabled,
          byAccountId: actor.accountId,
        },
      });
      await this.txm.afterCommit(() => this.features.invalidateAll());
    });
  }

  async setTeacher(
    actor: Actor,
    teacherId: string,
    rawKey: string,
    patch: PersonalPatch,
  ): Promise<ResolvedFeatures> {
    assertAdmin(actor);
    const { key } = this.validateTeacher(rawKey, patch);
    return this.txm.run(async () => {
      await this.assertTeacher(teacherId);
      const before = await this.features.compute(teacherId);
      const personalBefore = (await this.repo.listPersonal(teacherId)).find((p) => p.featureKey === key);
      const row = await this.repo.upsertPersonal(teacherId, key, patch, actor.accountId);
      const after = await this.features.compute(teacherId);
      const unchanged =
        (personalBefore?.enabled ?? null) === row.enabled && sameLimits(personalBefore?.limits, row.limits);
      if (unchanged) return after;
      const changed = [key, ...dependantsOf(key)].filter(
        (k) => before.get(k)?.enabled !== after.get(k)?.enabled,
      );
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: primaryRole(actor),
        action: 'feature.teacher_changed',
        entityType: 'account',
        entityId: teacherId,
        before: {
          key,
          personalEnabled: personalBefore?.enabled ?? null,
          personalLimits: personalBefore?.limits ?? null,
          effective: before.get(key)?.limits,
        },
        after: {
          key,
          personalEnabled: row.enabled,
          personalLimits: row.limits,
          effective: after.get(key)?.limits,
          effectiveChanged: changed,
        },
        source: actor.source,
        ip: actor.ip,
      });
      for (const k of changed) {
        await this.outbox.publish({
          type: 'feature.changed',
          aggregateType: 'account',
          aggregateId: teacherId,
          payload: {
            teacherId,
            feature: k,
            enabled: after.get(k)?.enabled ?? false,
            byAccountId: actor.accountId,
          },
        });
      }
      await this.txm.afterCommit(() => this.features.invalidate(teacherId));
      return after;
    });
  }

  /** Resets every personal override of a feature to the platform defaults. */
  async resetTeacher(actor: Actor, teacherId: string, rawKey: string): Promise<ResolvedFeatures> {
    return this.setTeacher(actor, teacherId, rawKey, { enabled: null, limits: null });
  }

  async assertTeacher(teacherId: string): Promise<void> {
    const teacher = await this.accounts.findById(teacherId);
    if (!teacher) throw AppError.notFound('account', teacherId);
    if (!(await this.accounts.activeRoles(teacherId)).includes('TEACHER')) {
      throw new AppError('CONFLICT', 'Features apply to teachers only');
    }
  }
}
