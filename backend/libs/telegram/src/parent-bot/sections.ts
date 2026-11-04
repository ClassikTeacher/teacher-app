/** ParentBot menu (4.4). Sections without a module show a placeholder until their milestone. */
export const PARENT_SECTIONS = [
  'children',
  'schedule',
  'assignments',
  'progress',
  'teachers',
  'requests',
  'settings',
] as const;

export type ParentSection = (typeof PARENT_SECTIONS)[number];

export const PARENT_SECTION_MODULES = Symbol('PARENT_SECTION_MODULES');

/** Session scratch key of the child a parent is currently looking at (5.4.3 "переключение ребёнка"). */
export const SELECTED_CHILD_KEY = 'childId';
