/**
 * Feature catalogue (5.3.2). Keys are stable identifiers used in `feature.key` and in menus.
 * Stage-2/3 features exist so admins can see them, but they stay off until implemented.
 */
export const FEATURE_KEYS = [
  'core',
  'calendar.open_booking',
  'calendar.google',
  'calendar.ics',
  'groups',
  'groups.telegram',
  'storage',
  'materials',
  'homework',
  'homework.submissions',
  'journal.school',
  'journal.tests',
  'journal.custom',
  'reports',
  'parents.cc',
  'invite.group_link',
  'bulk.cancel',
  'broadcasts',
  'web',
  'miniapp',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export type FeatureLimits = Record<string, number | null>;

export interface FeatureDefinition {
  key: FeatureKey;
  /** i18n key suffix: `feature-<slug>` */
  slug: string;
  dependsOn: readonly FeatureKey[];
  defaultEnabled: boolean;
  /** Limits with their default values; `null` means "no limit". */
  defaultLimits: FeatureLimits;
  stage: 1 | 2 | 3;
  /** `core` is not toggleable: it only carries platform-wide limits (max students). */
  toggleable: boolean;
}

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

const def = (
  key: FeatureKey,
  options: Partial<Omit<FeatureDefinition, 'key' | 'slug'>> & { stage?: 1 | 2 | 3 } = {},
): FeatureDefinition => ({
  key,
  slug: key.replace(/\./g, '-').replace(/_/g, '-'),
  dependsOn: options.dependsOn ?? [],
  defaultEnabled: options.defaultEnabled ?? true,
  defaultLimits: options.defaultLimits ?? {},
  stage: options.stage ?? 1,
  toggleable: options.toggleable ?? true,
});

export const FEATURE_CATALOG: readonly FeatureDefinition[] = [
  def('core', { toggleable: false, defaultLimits: { maxStudents: null } }),
  def('calendar.open_booking', { defaultEnabled: false }),
  def('calendar.google', { defaultEnabled: false, stage: 2 }),
  def('calendar.ics'),
  def('groups', { defaultLimits: { maxGroups: null } }),
  def('groups.telegram', { dependsOn: ['groups'], defaultEnabled: false, stage: 2 }),
  def('storage', { defaultLimits: { quotaBytes: 2 * GB, maxFileBytes: 20 * MB } }),
  def('materials', { dependsOn: ['storage'] }),
  def('homework'),
  def('homework.submissions', { dependsOn: ['homework', 'storage'] }),
  def('journal.school'),
  def('journal.tests'),
  def('journal.custom'),
  def('reports'),
  def('parents.cc'),
  def('invite.group_link', { defaultEnabled: false, stage: 2 }),
  def('bulk.cancel'),
  def('broadcasts', { defaultEnabled: false, stage: 2 }),
  def('web', { defaultEnabled: false, stage: 2 }),
  def('miniapp', { defaultEnabled: false, stage: 3 }),
];

export const FEATURE_BY_KEY: ReadonlyMap<FeatureKey, FeatureDefinition> = new Map(
  FEATURE_CATALOG.map((f) => [f.key, f]),
);

export function isFeatureKey(value: string): value is FeatureKey {
  return FEATURE_BY_KEY.has(value as FeatureKey);
}

/** Short identifiers for 64-byte callback payloads: catalogue position instead of the key. */
export function featureIndex(key: FeatureKey): number {
  return FEATURE_CATALOG.findIndex((f) => f.key === key);
}

export function featureByIndex(index: number | string): FeatureDefinition | null {
  const i = typeof index === 'string' ? Number(index) : index;
  return Number.isInteger(i) ? (FEATURE_CATALOG[i] ?? null) : null;
}

export function limitNames(definition: FeatureDefinition): string[] {
  return Object.keys(definition.defaultLimits);
}
