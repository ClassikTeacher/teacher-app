/** StudentBot menu (4.4). Sections without a module show a placeholder until their milestone. */
export const STUDENT_SECTIONS = [
  'schedule',
  'booking',
  'assignments',
  'materials',
  'progress',
  'cancel',
  'teachers',
  'parents',
  'archive',
  'settings',
] as const;

export type StudentSection = (typeof STUDENT_SECTIONS)[number];

export const STUDENT_SECTION_MODULES = Symbol('STUDENT_SECTION_MODULES');
