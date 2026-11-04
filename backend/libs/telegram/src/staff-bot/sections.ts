import { type Actor, isAdmin, isSuperAdmin } from '@modules/access/actor.js';
import type { FeatureKey } from '@modules/access/features/catalog.js';
import type { ResolvedFeatures } from '@modules/access/features/rules.js';

export type StaffSection =
  | 'today'
  | 'lesson'
  | 'students'
  | 'groups'
  | 'materials'
  | 'assignments'
  | 'journals'
  | 'reports'
  | 'attention'
  | 'settings'
  | 'teachers'
  | 'users'
  | 'features'
  | 'invitations'
  | 'subjects'
  | 'filetypes'
  | 'audit'
  | 'admins';

export interface SectionDef {
  key: StaffSection;
  parent: 'main' | 'admin';
  /** Role predicate (3.7). */
  roles: (actor: Actor) => boolean;
  /** The section is hidden and refused when any of these features is off for the teacher (5.3.3). */
  features?: readonly FeatureKey[];
  /** Visible when at least one of these is on (journals: any journal type or reports). */
  anyFeature?: readonly FeatureKey[];
  /** Reachable by buttons only, not from the menu grid (reports live inside «Журналы и отчёты»). */
  hidden?: boolean;
}

const teacher = (a: Actor): boolean => a.roles.includes('TEACHER');

/** Declarative registry (4.4): menus, authorization and placeholder parents all derive from it. */
export const SECTIONS: readonly SectionDef[] = [
  { key: 'today', parent: 'main', roles: teacher },
  { key: 'lesson', parent: 'main', roles: teacher },
  { key: 'students', parent: 'main', roles: teacher },
  { key: 'groups', parent: 'main', roles: teacher, features: ['groups'] },
  { key: 'materials', parent: 'main', roles: teacher, features: ['materials'] },
  { key: 'assignments', parent: 'main', roles: teacher, features: ['homework'] },
  {
    key: 'journals',
    parent: 'main',
    roles: teacher,
    anyFeature: ['journal.school', 'journal.tests', 'journal.custom', 'reports'],
  },
  { key: 'reports', parent: 'main', roles: teacher, features: ['reports'], hidden: true },
  { key: 'attention', parent: 'main', roles: teacher },
  { key: 'settings', parent: 'main', roles: teacher },
  { key: 'teachers', parent: 'admin', roles: isAdmin },
  { key: 'users', parent: 'admin', roles: isAdmin },
  { key: 'features', parent: 'admin', roles: isAdmin },
  { key: 'invitations', parent: 'admin', roles: isAdmin },
  { key: 'subjects', parent: 'admin', roles: isAdmin },
  { key: 'filetypes', parent: 'admin', roles: isAdmin },
  { key: 'audit', parent: 'admin', roles: isAdmin },
  { key: 'admins', parent: 'admin', roles: isSuperAdmin },
];

export const SECTION_BY_KEY: ReadonlyMap<StaffSection, SectionDef> = new Map(SECTIONS.map((s) => [s.key, s]));

export function isStaffSection(value: string): value is StaffSection {
  return SECTION_BY_KEY.has(value as StaffSection);
}

/** Sections the actor may open right now: roles plus the teacher's effective features. */
export function allowedSections(actor: Actor, features: ResolvedFeatures | null): SectionDef[] {
  const on = (key: FeatureKey): boolean => features?.get(key)?.enabled ?? false;
  return SECTIONS.filter((s) => {
    if (!s.roles(actor)) return false;
    if (s.features && !s.features.every(on)) return false;
    if (s.anyFeature && !s.anyFeature.some(on)) return false;
    return true;
  });
}

export function canOpen(section: StaffSection, actor: Actor, features: ResolvedFeatures | null): boolean {
  return allowedSections(actor, features).some((s) => s.key === section);
}
