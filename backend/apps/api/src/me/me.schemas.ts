import { z } from 'zod';
import { CALENDAR_MODES } from '@modules/people/schema.js';
import { MAX_PERSON_NAME_LENGTH } from '@modules/people/person-onboarding.service.js';
import {
  MAX_LESSON_DURATION_MIN,
  MIN_LESSON_DURATION_MIN,
} from '@modules/people/teacher-profile.defaults.js';
import {
  MAX_BUFFER_MIN,
  MAX_CANCEL_HOURS,
  MAX_NOTICE_TEXT_LENGTH,
  MAX_TEMPLATE_TEXT_LENGTH,
} from '@modules/people/teacher-settings.rules.js';

const int = z.number().int();

/** PATCH /me body (9.2 "Me"); every field optional, validated again by the use-case rules. */
export const updateMeSchema = z
  .object({
    firstName: z.string().trim().min(1).max(MAX_PERSON_NAME_LENGTH).optional(),
    lastName: z.string().trim().max(MAX_PERSON_NAME_LENGTH).optional(),
    timezone: z.string().min(1).max(64).optional(),
    subjectIds: z.array(z.string().uuid()).min(1).max(20).optional(),
    defaultDurationMin: int.min(MIN_LESSON_DURATION_MIN).max(MAX_LESSON_DURATION_MIN).optional(),
    bufferBeforeMin: int.min(0).max(MAX_BUFFER_MIN).optional(),
    bufferAfterMin: int.min(0).max(MAX_BUFFER_MIN).optional(),
    lateCancelHours: int.min(0).max(MAX_CANCEL_HOURS).optional(),
    studentCancelCutoffHours: int.min(0).max(MAX_CANCEL_HOURS).nullable().optional(),
    studentCanCancel: z.boolean().optional(),
    parentCanCancel: z.boolean().optional(),
    defaultNoticeText: z.string().trim().min(1).max(MAX_NOTICE_TEXT_LENGTH).optional(),
    calendarMode: z.enum(CALENDAR_MODES).optional(),
    bookingConfirmation: z.enum(['auto', 'manual']).optional(),
    bookingRules: z
      .object({
        minNoticeHours: int
          .min(0)
          .max(24 * 14)
          .optional(),
        horizonDays: int.min(1).max(90).optional(),
        durations: z.array(int.min(MIN_LESSON_DURATION_MIN).max(MAX_LESSON_DURATION_MIN)).max(6).optional(),
        gridStepMin: z.union([z.literal(15), z.literal(30), z.literal(60)]).optional(),
        maxPendingPerSlot: int.min(1).max(10).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type UpdateMeDto = z.infer<typeof updateMeSchema>;

export const templateKindSchema = z.enum(['cancel_reason', 'end_link']).default('cancel_reason');
export type TemplateKindDto = z.infer<typeof templateKindSchema>;

export const createTemplateSchema = z.object({
  kind: templateKindSchema,
  text: z.string().trim().min(1).max(MAX_TEMPLATE_TEXT_LENGTH),
});
export type CreateTemplateDto = z.infer<typeof createTemplateSchema>;
