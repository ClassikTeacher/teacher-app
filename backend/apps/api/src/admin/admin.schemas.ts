import { z } from 'zod';

export const createInvitationSchema = z.object({
  role: z.enum(['TEACHER', 'ADMIN']),
  targetTelegramUserId: z.number().int().positive().nullable().optional(),
  displayName: z.string().trim().min(1).max(100).optional(),
});
export type CreateInvitationDto = z.infer<typeof createInvitationSchema>;

export const blockUserSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  lessonsPolicy: z.enum(['cancel', 'keep']).default('keep'),
  message: z.string().trim().min(1).max(1000).nullable().optional(),
});
export type BlockUserDto = z.infer<typeof blockUserSchema>;

export const grantAdminSchema = z.object({ accountId: z.string().uuid() });
export type GrantAdminDto = z.infer<typeof grantAdminSchema>;

export const uuidParam = z.string().uuid();
