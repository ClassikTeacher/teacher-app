import { z } from 'zod';
import {
  MAX_ALIAS_LENGTH,
  MAX_GOALS_LENGTH,
  MAX_GRADE_LENGTH,
  MAX_MAX_LESSONS_PER_WEEK,
  MAX_NOTES_LENGTH,
  MAX_SCHOOL_LENGTH,
  MIN_MAX_LESSONS_PER_WEEK,
} from '@modules/people/links/link.rules.js';

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const weeklyLimit = z.number().int().min(MIN_MAX_LESSONS_PER_WEEK).max(MAX_MAX_LESSONS_PER_WEEK);
const MAX_SUBJECTS = 20;

/** PATCH /students/{id} (9.2 "Students"): card fields of 5.4.1 incl. weekly limit and subjects. */
export const updateStudentSchema = z
  .object({
    alias: optionalText(MAX_ALIAS_LENGTH),
    goals: optionalText(MAX_GOALS_LENGTH),
    notes: optionalText(MAX_NOTES_LENGTH),
    grade: optionalText(MAX_GRADE_LENGTH),
    school: optionalText(MAX_SCHOOL_LENGTH),
    maxLessonsPerWeek: weeklyLimit.nullable().optional(),
    calendarOpen: z.boolean().nullable().optional(),
    subjectIds: z.array(z.string().uuid()).min(1).max(MAX_SUBJECTS).optional(),
  })
  .strict();
export type UpdateStudentDto = z.infer<typeof updateStudentSchema>;

export const createStudentInvitationSchema = z.object({
  subjectIds: z.array(z.string().uuid()).min(1).max(MAX_SUBJECTS),
  maxLessonsPerWeek: weeklyLimit.nullable().default(2),
  displayName: z.string().trim().min(1).max(100).optional(),
  grade: z.string().trim().min(1).max(MAX_GRADE_LENGTH).optional(),
});
export type CreateStudentInvitationDto = z.infer<typeof createStudentInvitationSchema>;

export const studentsQuerySchema = z.object({
  status: z.enum(['active', 'pending', 'ended']).default('active'),
});
export type StudentsQueryDto = z.infer<typeof studentsQuerySchema>;
