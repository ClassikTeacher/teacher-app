import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { FEATURE_CATALOG, type FeatureKey, type FeatureLimits } from './catalog.js';
import { type AccountFeatureRow, accountFeature, feature, type FeatureRow } from './schema.js';

export interface GlobalPatch {
  globalEnabled?: boolean;
  defaultEnabled?: boolean;
  /** Merged key by key into the stored defaults; a `null` value means "unlimited". */
  defaultLimits?: FeatureLimits;
}

export interface PersonalPatch {
  /** `null` resets to the default. */
  enabled?: boolean | null;
  /** Merged key by key; `null` drops every personal limit. */
  limits?: FeatureLimits | null;
}

@Injectable()
export class FeatureRepository {
  constructor(private readonly txm: TransactionManager) {}

  /** Inserts catalogue entries that do not exist yet; never overrides admin changes. Idempotent. */
  async seedCatalog(): Promise<number> {
    const rows = await this.txm.db
      .insert(feature)
      .values(
        FEATURE_CATALOG.map((f) => ({
          key: f.key,
          globalEnabled: true,
          defaultEnabled: f.defaultEnabled,
          defaultLimits: f.defaultLimits,
        })),
      )
      .onConflictDoNothing({ target: feature.key })
      .returning({ key: feature.key });
    return rows.length;
  }

  async listGlobal(): Promise<FeatureRow[]> {
    return this.txm.db.select().from(feature);
  }

  async listPersonal(accountId: string): Promise<AccountFeatureRow[]> {
    return this.txm.db.select().from(accountFeature).where(eq(accountFeature.accountId, accountId));
  }

  /** Row-locked read-modify-write so concurrent admins do not lose each other's limit edits. */
  async upsertGlobal(key: FeatureKey, patch: GlobalPatch, updatedBy: string): Promise<FeatureRow> {
    const definition = FEATURE_CATALOG.find((f) => f.key === key)!;
    const [current] = await this.txm.db.select().from(feature).where(eq(feature.key, key)).for('update');
    const base = current ?? {
      key,
      globalEnabled: true,
      defaultEnabled: definition.defaultEnabled,
      defaultLimits: definition.defaultLimits,
    };
    const values = {
      key,
      globalEnabled: patch.globalEnabled ?? base.globalEnabled,
      defaultEnabled: patch.defaultEnabled ?? base.defaultEnabled,
      defaultLimits: { ...base.defaultLimits, ...(patch.defaultLimits ?? {}) },
      updatedBy,
    };
    const rows = await this.txm.db
      .insert(feature)
      .values(values)
      .onConflictDoUpdate({ target: feature.key, set: values })
      .returning();
    return rows[0]!;
  }

  async upsertPersonal(
    accountId: string,
    key: FeatureKey,
    patch: PersonalPatch,
    updatedBy: string,
  ): Promise<AccountFeatureRow> {
    const [current] = await this.txm.db
      .select()
      .from(accountFeature)
      .where(sql`${accountFeature.accountId} = ${accountId} AND ${accountFeature.featureKey} = ${key}`)
      .for('update');
    const limits =
      patch.limits === null
        ? null
        : patch.limits === undefined
          ? (current?.limits ?? null)
          : { ...(current?.limits ?? {}), ...patch.limits };
    const values = {
      accountId,
      featureKey: key,
      enabled: patch.enabled === undefined ? (current?.enabled ?? null) : patch.enabled,
      limits,
      updatedBy,
    };
    const rows = await this.txm.db
      .insert(accountFeature)
      .values(values)
      .onConflictDoUpdate({ target: [accountFeature.accountId, accountFeature.featureKey], set: values })
      .returning();
    return rows[0]!;
  }
}
