import { SECTION_NS, type SectionModule, sectionCb } from '../core/sections.js';
import type { StaffSection } from './sections.js';

export { SECTION_NS, sectionCb };

/** A StaffBot screen (see core/sections.ts). */
export type StaffSectionModule = SectionModule<StaffSection>;

export const STAFF_SECTIONS = Symbol('STAFF_SECTIONS');
