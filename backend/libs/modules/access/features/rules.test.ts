import { describe, expect, it } from 'vitest';
import { FEATURE_CATALOG, type FeatureKey } from './catalog.js';
import {
  dependantsOf,
  type GlobalFeatureState,
  type PersonalFeatureState,
  resolveFeatures,
} from './rules.js';

const globals = (entries: Partial<Record<FeatureKey, Partial<GlobalFeatureState>>> = {}) =>
  new Map(
    Object.entries(entries).map(([k, v]) => [
      k as FeatureKey,
      { globalEnabled: true, defaultEnabled: true, defaultLimits: {}, ...v },
    ]),
  );
const personal = (entries: Partial<Record<FeatureKey, PersonalFeatureState>> = {}) =>
  new Map(Object.entries(entries) as Array<[FeatureKey, PersonalFeatureState]>);

describe('resolveFeatures (5.3.1)', () => {
  it('uses catalogue defaults when nothing is stored', () => {
    const r = resolveFeatures(globals(), personal());
    expect(r.get('homework')?.enabled).toBe(true);
    expect(r.get('calendar.open_booking')).toMatchObject({ enabled: false, reason: 'default' });
    expect(r.get('storage')?.limits).toEqual({ quotaBytes: 2 * 1024 ** 3, maxFileBytes: 20 * 1024 ** 2 });
    expect(r.size).toBe(FEATURE_CATALOG.length);
  });

  it('personal value overrides the default; global switch overrides everything', () => {
    const on = resolveFeatures(
      globals(),
      personal({ 'calendar.open_booking': { enabled: true, limits: null } }),
    );
    expect(on.get('calendar.open_booking')).toMatchObject({
      enabled: true,
      reason: null,
      personalEnabled: true,
    });

    const off = resolveFeatures(
      globals({ homework: { defaultEnabled: true } }),
      personal({ homework: { enabled: false, limits: null } }),
    );
    expect(off.get('homework')).toMatchObject({ enabled: false, reason: 'personal' });

    const killed = resolveFeatures(
      globals({ homework: { globalEnabled: false } }),
      personal({ homework: { enabled: true, limits: null } }),
    );
    expect(killed.get('homework')).toMatchObject({ enabled: false, reason: 'global' });
  });

  it('disables dependants when a dependency is off, transitively', () => {
    const r = resolveFeatures(globals(), personal({ storage: { enabled: false, limits: null } }));
    expect(r.get('materials')).toMatchObject({ enabled: false, reason: 'dependency' });
    expect(r.get('homework.submissions')).toMatchObject({ enabled: false, reason: 'dependency' });
    expect(r.get('homework')?.enabled).toBe(true);
    expect(dependantsOf('storage').sort()).toEqual(['homework.submissions', 'materials']);
    expect(dependantsOf('groups')).toEqual(['groups.telegram']);
  });

  it('merges limits: catalogue < global defaults < personal; core is never toggleable', () => {
    const r = resolveFeatures(
      globals({
        storage: { defaultLimits: { quotaBytes: 1 } },
        core: { globalEnabled: false, defaultEnabled: false },
      }),
      personal({ storage: { enabled: null, limits: { maxFileBytes: 5 } } }),
    );
    expect(r.get('storage')?.limits).toEqual({ quotaBytes: 1, maxFileBytes: 5 });
    expect(r.get('core')).toMatchObject({ enabled: true, limits: { maxStudents: null } });
  });
});
