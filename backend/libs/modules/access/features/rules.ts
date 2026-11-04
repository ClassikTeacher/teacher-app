import { FEATURE_BY_KEY, FEATURE_CATALOG, type FeatureKey, type FeatureLimits } from './catalog.js';

export interface GlobalFeatureState {
  globalEnabled: boolean;
  defaultEnabled: boolean;
  defaultLimits: FeatureLimits;
}

export interface PersonalFeatureState {
  enabled: boolean | null;
  limits: FeatureLimits | null;
}

export type DisabledReason = 'global' | 'personal' | 'default' | 'dependency';

export interface ResolvedFeature {
  key: FeatureKey;
  enabled: boolean;
  /** Why it is off; `null` when enabled. */
  reason: DisabledReason | null;
  /** Effective limits: personal keys override the defaults. */
  limits: FeatureLimits;
  /** Inputs, for admin screens. */
  globalEnabled: boolean;
  defaultEnabled: boolean;
  personalEnabled: boolean | null;
}

export type ResolvedFeatures = ReadonlyMap<FeatureKey, ResolvedFeature>;

/**
 * Pure rule (5.3.1): enabled = global AND (personal ?? default) AND every dependency enabled.
 * Missing rows fall back to the catalogue defaults, so the catalogue alone is a valid state.
 */
export function resolveFeatures(
  globals: ReadonlyMap<FeatureKey, GlobalFeatureState>,
  personal: ReadonlyMap<FeatureKey, PersonalFeatureState>,
): ResolvedFeatures {
  const result = new Map<FeatureKey, ResolvedFeature>();
  const own = (
    key: FeatureKey,
  ): Omit<ResolvedFeature, 'enabled' | 'reason'> & {
    ownEnabled: boolean;
    ownReason: DisabledReason | null;
  } => {
    const definition = FEATURE_BY_KEY.get(key)!;
    const global = globals.get(key) ?? {
      globalEnabled: true,
      defaultEnabled: definition.defaultEnabled,
      defaultLimits: definition.defaultLimits,
    };
    const mine = personal.get(key) ?? { enabled: null, limits: null };
    const limits: FeatureLimits = {
      ...definition.defaultLimits,
      ...global.defaultLimits,
      ...(mine.limits ?? {}),
    };
    let ownEnabled: boolean;
    let ownReason: DisabledReason | null = null;
    if (!definition.toggleable) {
      ownEnabled = true;
    } else if (!global.globalEnabled) {
      ownEnabled = false;
      ownReason = 'global';
    } else if (mine.enabled !== null) {
      ownEnabled = mine.enabled;
      ownReason = mine.enabled ? null : 'personal';
    } else {
      ownEnabled = global.defaultEnabled;
      ownReason = global.defaultEnabled ? null : 'default';
    }
    return {
      key,
      limits,
      globalEnabled: global.globalEnabled,
      defaultEnabled: global.defaultEnabled,
      personalEnabled: mine.enabled,
      ownEnabled,
      ownReason,
    };
  };

  const resolve = (key: FeatureKey): ResolvedFeature => {
    const cached = result.get(key);
    if (cached) return cached;
    const { ownEnabled, ownReason, ...rest } = own(key);
    let enabled = ownEnabled;
    let reason = ownReason;
    if (enabled) {
      for (const dep of FEATURE_BY_KEY.get(key)!.dependsOn) {
        if (!resolve(dep).enabled) {
          enabled = false;
          reason = 'dependency';
          break;
        }
      }
    }
    const resolved: ResolvedFeature = { ...rest, enabled, reason };
    result.set(key, resolved);
    return resolved;
  };

  for (const definition of FEATURE_CATALOG) resolve(definition.key);
  return result;
}

/** Features that depend (directly or transitively) on `key` — shown to admins before switching it off. */
export function dependantsOf(key: FeatureKey): FeatureKey[] {
  const out = new Set<FeatureKey>();
  const visit = (k: FeatureKey): void => {
    for (const f of FEATURE_CATALOG) {
      if (f.dependsOn.includes(k) && !out.has(f.key)) {
        out.add(f.key);
        visit(f.key);
      }
    }
  };
  visit(key);
  return [...out];
}
