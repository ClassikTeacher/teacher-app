import type { Bot, Role } from '@modules/identity/schema.js';

/**
 * Registry of message types (5.13.1) lives in code. `bot` is derived from the recipient role (5.13.1 "Бот доставки");
 * `critical` messages ignore quiet hours and cannot be muted (NTF-02, NTF-06; applied in M4-05).
 */
export interface NotificationType {
  code: string;
  critical: boolean;
  ccParentsByDefault: boolean;
  recipientCanDisable: boolean;
}

export const NOTIFICATION_TYPES = {
  'admin.teacher_onboarded': {
    code: 'admin.teacher_onboarded',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: true,
  },
  'admin.invitation_expired': {
    code: 'admin.invitation_expired',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: true,
  },
  'feature.changed': {
    code: 'feature.changed',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  'role.granted': {
    code: 'role.granted',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  'account.unblocked': {
    code: 'account.unblocked',
    critical: true,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  'security.sa_transfer_requested': {
    code: 'security.sa_transfer_requested',
    critical: true,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  'security.sa_transfer_confirmed': {
    code: 'security.sa_transfer_confirmed',
    critical: true,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  'security.sa_transfer_declined': {
    code: 'security.sa_transfer_declined',
    critical: true,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  'security.sa_transfer_cancelled': {
    code: 'security.sa_transfer_cancelled',
    critical: true,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  'link.student_joined': {
    code: 'link.student_joined',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  'link.declined': {
    code: 'link.declined',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  // family.* rows are not in the 5.13.1 registry yet (UC-11 step 4 names them): proposed for the spec, non-critical (NTF-02)
  'family.parent_linked': {
    code: 'family.parent_linked',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  'family.parent_connected': {
    code: 'family.parent_connected',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  'family.parent_unlinked': {
    code: 'family.parent_unlinked',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  // 5.8 / 5.13.1: ending a link and the parents' consent flow are critical (NTF-02) and cannot be muted
  'link.ended': { code: 'link.ended', critical: true, ccParentsByDefault: true, recipientCanDisable: false },
  'link.leave_request': {
    code: 'link.leave_request',
    critical: true,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  'link.leave_reminder': {
    code: 'link.leave_reminder',
    critical: true,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  'link.leave_decided': {
    code: 'link.leave_decided',
    critical: true,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  'link.leave_expired': {
    code: 'link.leave_expired',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  // 5.13.1 lessons (M3-02): assignment of a lesson and reminders; member conflicts are a teacher-only service note
  'lesson.created': {
    code: 'lesson.created',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  'lesson.participants_changed': {
    code: 'lesson.participants_changed',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  'lesson.reminder': {
    code: 'lesson.reminder',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: true,
  },
  'lesson.member_conflicts': {
    code: 'lesson.member_conflicts',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  // 5.5.6: the teacher learns which instances of a series could not be placed (UC-39)
  'series.conflicts': {
    code: 'series.conflicts',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  // 5.6.4 / 5.13.1: the report request to the teacher (LES-06, LES-07) and the summary to the student (LES-08)
  'lesson.report_required': {
    code: 'lesson.report_required',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  'lesson.summary': {
    code: 'lesson.summary',
    critical: false,
    ccParentsByDefault: true,
    recipientCanDisable: true,
  },
  // 5.7 / 5.13.1 (M4-01): cancellations reach every other side and parents by default; absence → teacher
  'lesson.cancelled': {
    code: 'lesson.cancelled',
    critical: true,
    ccParentsByDefault: true,
    recipientCanDisable: false,
  },
  // 5.7.5 / NTF-07: one summary per recipient for a bulk cancellation
  'cancellation.bulk': {
    code: 'cancellation.bulk',
    critical: true,
    ccParentsByDefault: true,
    recipientCanDisable: false,
  },
  // 5.7.4 / 5.13.1 (M4-03): a move reaches the other side with «ОК / Не могу»; requests go to the teacher,
  // decisions («слот занят» included) to the student; an objection to a move reaches the teacher
  'lesson.rescheduled': {
    code: 'lesson.rescheduled',
    critical: true,
    ccParentsByDefault: true,
    recipientCanDisable: false,
  },
  'lesson.reschedule_objection': {
    code: 'lesson.reschedule_objection',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  'booking.requested': {
    code: 'booking.requested',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  'booking.decided': {
    code: 'booking.decided',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  'lesson.absence': {
    code: 'lesson.absence',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  // 5.5.7 / 5.13.1 (M4-05): the teacher's morning digest; NTF-09: a student's bot became unreachable
  'digest.daily': {
    code: 'digest.daily',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: true,
  },
  // 5.7.6 (M4-06): a student removed from a group (or the group archived) loses its future lessons
  'group.lessons_left': {
    code: 'group.lessons_left',
    critical: false,
    ccParentsByDefault: true,
    recipientCanDisable: false,
  },
  'channel.unreachable': {
    code: 'channel.unreachable',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  // 5.9.3 / 5.13.1 (M5-02): a material or a collection handed to the student; parents by the teacher's choice
  'material.granted': {
    code: 'material.granted',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: true,
  },
  // 5.10 / 5.13.1 (M5-03, M5-04): homework to the student (copies by default), submissions to the teacher
  'homework.assigned': {
    code: 'homework.assigned',
    critical: false,
    ccParentsByDefault: true,
    recipientCanDisable: true,
  },
  'homework.due_soon': {
    code: 'homework.due_soon',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: true,
  },
  'homework.overdue': {
    code: 'homework.overdue',
    critical: false,
    ccParentsByDefault: true,
    recipientCanDisable: true,
  },
  'submission.received': {
    code: 'submission.received',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: true,
  },
  'submission.reviewed': {
    code: 'submission.reviewed',
    critical: false,
    ccParentsByDefault: true,
    recipientCanDisable: false,
  },
  // HW-05 (M5-01): a deferred antivirus check found a threat; the uploader and the owner learn why the file is gone
  'file.infected': {
    code: 'file.infected',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  // UC-27 (M5-04): the teacher's storage is full, a student could not hand in files
  'storage.full': {
    code: 'storage.full',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
  // 5.5.6: one message per series instead of one per instance (NTF-07)
  'series.created': {
    code: 'series.created',
    critical: false,
    ccParentsByDefault: false,
    recipientCanDisable: false,
  },
} as const satisfies Record<string, NotificationType>;

export type NotificationTypeCode = keyof typeof NOTIFICATION_TYPES;

/** Student messages a teacher may copy to parents (NTF-01), in the order the settings screens show them. */
export const CC_CONFIGURABLE_TYPES: readonly NotificationTypeCode[] = [
  'lesson.cancelled',
  'lesson.rescheduled',
  'cancellation.bulk',
  'lesson.created',
  'lesson.summary',
  'booking.decided',
  'series.created',
  'material.granted',
  'homework.assigned',
  'homework.overdue',
  'submission.reviewed',
  'link.ended',
];

/** Types a recipient may switch off for themselves (5.13.1 «Получатель может отключить»). */
export const MUTEABLE_TYPES: readonly NotificationTypeCode[] = (
  Object.keys(NOTIFICATION_TYPES) as NotificationTypeCode[]
).filter((code) => NOTIFICATION_TYPES[code].recipientCanDisable);

/** Copies a parent may switch off (NTF-02): the non-critical ones among the copyable types. */
export const PARENT_MUTEABLE_TYPES: readonly NotificationTypeCode[] = CC_CONFIGURABLE_TYPES.filter(
  (code) =>
    !NOTIFICATION_TYPES[code].critical ||
    code === 'lesson.cancelled' ||
    code === 'lesson.rescheduled' ||
    code === 'cancellation.bulk',
);

export function isNotificationType(code: string): code is NotificationTypeCode {
  return code in NOTIFICATION_TYPES;
}

/** Which bot delivers to a recipient with these roles (5.13.1). Staff messages go to StaffBot; AuthBot is security-only. */
export function botForRecipient(roles: readonly Role[], purpose: 'work' | 'security' = 'work'): Bot {
  if (purpose === 'security') return 'auth';
  if (roles.includes('TEACHER') || roles.includes('ADMIN') || roles.includes('SUPER_ADMIN')) return 'staff';
  if (roles.includes('PARENT') && !roles.includes('STUDENT')) return 'parent';
  return 'student';
}

/** Inline buttons attached to a notification; `data` is the callback payload handled by the receiving bot. */
export interface NotificationButton {
  text: string;
  data: string;
}

export const BUTTONS_PAYLOAD_KEY = 'buttons';
