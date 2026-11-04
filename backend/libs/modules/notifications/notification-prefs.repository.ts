import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import {
  notificationProfile,
  type NotificationProfileRow,
  notificationSetting,
  type NotificationSettingRow,
  type SettingKind,
} from './schema.js';

export const DEFAULT_PROFILE: Omit<NotificationProfileRow, 'accountId' | 'createdAt' | 'updatedAt'> = {
  reminderOffsetsMin: [1440, 60],
  quietEnabled: true,
  quietFrom: '22:00:00',
  quietTo: '08:00:00',
  digestEnabled: true,
  digestTime: '08:00:00',
  deliverViaParent: false,
};

export type ProfilePatch = Partial<typeof DEFAULT_PROFILE>;

/** Preferences (profile) and per-type switches (settings) of accounts; defaults when nothing is stored. */
@Injectable()
export class NotificationPrefsRepository {
  constructor(private readonly txm: TransactionManager) {}

  async profile(accountId: string): Promise<NotificationProfileRow> {
    const rows = await this.txm.db
      .select()
      .from(notificationProfile)
      .where(eq(notificationProfile.accountId, accountId))
      .limit(1);
    return rows[0] ?? { accountId, ...DEFAULT_PROFILE, createdAt: new Date(0), updatedAt: new Date(0) };
  }

  async profiles(accountIds: readonly string[]): Promise<Map<string, NotificationProfileRow>> {
    const out = new Map<string, NotificationProfileRow>();
    if (accountIds.length === 0) return out;
    const rows = await this.txm.db
      .select()
      .from(notificationProfile)
      .where(inArray(notificationProfile.accountId, [...accountIds]));
    for (const r of rows) out.set(r.accountId, r);
    for (const id of accountIds)
      if (!out.has(id))
        out.set(id, { accountId: id, ...DEFAULT_PROFILE, createdAt: new Date(0), updatedAt: new Date(0) });
    return out;
  }

  async upsertProfile(accountId: string, patch: ProfilePatch): Promise<NotificationProfileRow> {
    const rows = await this.txm.db
      .insert(notificationProfile)
      .values({ accountId, ...DEFAULT_PROFILE, ...patch })
      .onConflictDoUpdate({ target: notificationProfile.accountId, set: patch })
      .returning();
    return rows[0]!;
  }

  /** All switches of an owner (one kind, optionally one student). */
  async settings(
    ownerId: string,
    kind: SettingKind,
    studentId?: string | null,
  ): Promise<NotificationSettingRow[]> {
    return this.txm.db
      .select()
      .from(notificationSetting)
      .where(
        and(
          eq(notificationSetting.ownerId, ownerId),
          eq(notificationSetting.kind, kind),
          studentId === undefined
            ? undefined
            : studentId === null
              ? isNull(notificationSetting.studentId)
              : eq(notificationSetting.studentId, studentId),
        ),
      );
  }

  /** Switches of several owners at once (one query for a message with many recipients). */
  async settingsOf(ownerIds: readonly string[], kind: SettingKind): Promise<NotificationSettingRow[]> {
    if (ownerIds.length === 0) return [];
    return this.txm.db
      .select()
      .from(notificationSetting)
      .where(and(inArray(notificationSetting.ownerId, [...ownerIds]), eq(notificationSetting.kind, kind)));
  }

  async setSetting(
    ownerId: string,
    kind: SettingKind,
    typeCode: string,
    enabled: boolean,
    studentId: string | null = null,
  ): Promise<NotificationSettingRow> {
    const rows = await this.txm.db
      .insert(notificationSetting)
      .values({ id: newId(), ownerId, kind, typeCode, enabled, studentId })
      .onConflictDoUpdate({
        target: [
          notificationSetting.ownerId,
          notificationSetting.kind,
          notificationSetting.typeCode,
          notificationSetting.studentId,
        ],
        set: { enabled },
      })
      .returning();
    return rows[0]!;
  }

  /** Removes a per-student override (back to the teacher's default). */
  async clearSetting(
    ownerId: string,
    kind: SettingKind,
    typeCode: string,
    studentId: string | null,
  ): Promise<void> {
    await this.txm.db
      .delete(notificationSetting)
      .where(
        and(
          eq(notificationSetting.ownerId, ownerId),
          eq(notificationSetting.kind, kind),
          eq(notificationSetting.typeCode, typeCode),
          studentId === null
            ? isNull(notificationSetting.studentId)
            : eq(notificationSetting.studentId, studentId),
        ),
      );
  }
}
