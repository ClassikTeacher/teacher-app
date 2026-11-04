import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { newId } from '@shared/ids/index.js';
import {
  account,
  type AccountInsert,
  accountRole,
  type AccountRoleRow,
  type AccountRow,
  type Bot,
  botChat,
  type BotChatRow,
  consent,
  type ConsentRow,
  type Role,
} from './schema.js';

export type NewAccount = Omit<AccountInsert, 'id' | 'createdAt' | 'updatedAt'>;
export type AccountPatch = Partial<Omit<AccountInsert, 'id' | 'telegramUserId' | 'createdAt' | 'updatedAt'>>;

/** Persistence for accounts, roles, bot chats and consents. Pure data access: no business rules here. */
@Injectable()
export class AccountRepository {
  constructor(private readonly txm: TransactionManager) {}

  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<AccountRow | null> {
    const query = this.txm.db.select().from(account).where(eq(account.id, id)).limit(1);
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  /** First contact of a Telegram user: tolerant to two concurrent first contacts (unique telegram_user_id). */
  async insertOrGetByTelegramUserId(data: NewAccount): Promise<{ row: AccountRow; created: boolean }> {
    const inserted = await this.txm.db
      .insert(account)
      .values({ ...data, id: newId() })
      .onConflictDoNothing({ target: account.telegramUserId })
      .returning();
    if (inserted[0]) return { row: inserted[0], created: true };
    const existing = await this.findByTelegramUserId(data.telegramUserId);
    if (!existing) throw new Error('account vanished after conflict');
    return { row: existing, created: false };
  }

  async findByIds(ids: readonly string[]): Promise<AccountRow[]> {
    if (ids.length === 0) return [];
    return this.txm.db
      .select()
      .from(account)
      .where(inArray(account.id, [...ids]));
  }

  async findByTelegramUserId(telegramUserId: number): Promise<AccountRow | null> {
    const rows = await this.txm.db
      .select()
      .from(account)
      .where(eq(account.telegramUserId, telegramUserId))
      .limit(1);
    return rows[0] ?? null;
  }

  async insert(data: NewAccount): Promise<AccountRow> {
    const rows = await this.txm.db
      .insert(account)
      .values({ ...data, id: newId() })
      .returning();
    return rows[0]!;
  }

  async update(id: string, patch: AccountPatch): Promise<AccountRow> {
    if (Object.keys(patch).length === 0) {
      const current = await this.findById(id);
      if (!current) throw new Error(`account ${id} not found`);
      return current;
    }
    const rows = await this.txm.db.update(account).set(patch).where(eq(account.id, id)).returning();
    const row = rows[0];
    if (!row) throw new Error(`account ${id} not found`);
    return row;
  }

  /** Accounts holding an active role, newest first, with optional name/username search (admin screens). */
  async listByRole(
    role: Role,
    options: { page: number; limit: number; query?: string } = { page: 1, limit: 20 },
  ): Promise<{ items: Array<AccountRow & { roles: Role[] }>; total: number }> {
    const holders = this.txm.db
      .select({ accountId: accountRole.accountId })
      .from(accountRole)
      .where(and(eq(accountRole.role, role), isNull(accountRole.revokedAt)));
    const filters = [inArray(account.id, holders)];
    if (options.query?.trim()) filters.push(this.searchFilter(options.query));
    const where = and(...filters);
    const limit = Math.min(Math.max(1, options.limit), 100);
    const page = Math.max(1, options.page);
    const items = await this.txm.db
      .select()
      .from(account)
      .where(where)
      .orderBy(desc(account.createdAt), asc(account.id))
      .limit(limit)
      .offset((page - 1) * limit);
    const total = await this.txm.db.$count(account, where);
    return { items: await this.withRoles(items), total };
  }

  /** Free-text search over names and username (admin "Пользователи"). */
  async search(query: string, limit = 10): Promise<Array<AccountRow & { roles: Role[] }>> {
    const items = await this.txm.db
      .select()
      .from(account)
      .where(this.searchFilter(query))
      .orderBy(asc(account.lastName), asc(account.firstName))
      .limit(limit);
    return this.withRoles(items);
  }

  /** Every whitespace-separated token must match a name part or the username ("Иван Петров" finds Иван Петров). */
  private searchFilter(query: string) {
    const tokens = query
      .trim()
      .replace(/^@/, '')
      .split(/\s+/)
      .map((t) => t.replace(/[%_]/g, '').split(String.fromCharCode(92)).join('')) // LIKE wildcards and the escape char
      .filter(Boolean)
      .slice(0, 4);
    const perToken = tokens.map((t) => {
      const pattern = `%${t}%`;
      return or(
        ilike(account.firstName, pattern),
        ilike(account.lastName, pattern),
        ilike(account.username, pattern),
      )!;
    });
    return perToken.length > 0 ? and(...perToken)! : sql`false`;
  }

  private async withRoles(items: AccountRow[]): Promise<Array<AccountRow & { roles: Role[] }>> {
    if (items.length === 0) return [];
    const rows = await this.txm.db
      .select({ accountId: accountRole.accountId, role: accountRole.role })
      .from(accountRole)
      .where(
        and(
          inArray(
            accountRole.accountId,
            items.map((i) => i.id),
          ),
          isNull(accountRole.revokedAt),
        ),
      );
    const byAccount = new Map<string, Role[]>();
    for (const r of rows) byAccount.set(r.accountId, [...(byAccount.get(r.accountId) ?? []), r.role]);
    return items.map((i) => ({ ...i, roles: byAccount.get(i.id) ?? [] }));
  }

  async activeRoles(accountId: string): Promise<Role[]> {
    const rows = await this.txm.db
      .select({ role: accountRole.role })
      .from(accountRole)
      .where(and(eq(accountRole.accountId, accountId), isNull(accountRole.revokedAt)));
    return rows.map((r) => r.role);
  }

  async grantRole(accountId: string, role: Role, grantedBy: string | null): Promise<AccountRoleRow> {
    const rows = await this.txm.db
      .insert(accountRole)
      .values({ id: newId(), accountId, role, grantedBy })
      .returning();
    return rows[0]!;
  }

  async revokeRole(accountId: string, role: Role, revokedBy: string | null): Promise<boolean> {
    const rows = await this.txm.db
      .update(accountRole)
      .set({ revokedAt: sql`now()`, revokedBy })
      .where(
        and(eq(accountRole.accountId, accountId), eq(accountRole.role, role), isNull(accountRole.revokedAt)),
      )
      .returning({ id: accountRole.id });
    return rows.length > 0;
  }

  async upsertBotChat(accountId: string, bot: Bot, chatId: number): Promise<BotChatRow> {
    const rows = await this.txm.db
      .insert(botChat)
      .values({ id: newId(), accountId, bot, chatId, isReachable: true, lastSeenAt: new Date() })
      .onConflictDoUpdate({
        target: [botChat.accountId, botChat.bot],
        set: { chatId, isReachable: true, lastError: null, lastSeenAt: new Date() },
      })
      .returning();
    return rows[0]!;
  }

  async findBotChat(accountId: string, bot: Bot): Promise<BotChatRow | null> {
    const rows = await this.txm.db
      .select()
      .from(botChat)
      .where(and(eq(botChat.accountId, accountId), eq(botChat.bot, bot)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Returns true when the chat just flipped from reachable to unreachable (one warning per incident, NTF-09). */
  async markBotChatUnreachable(accountId: string, bot: Bot, error: string): Promise<boolean> {
    const rows = await this.txm.db
      .update(botChat)
      .set({ isReachable: false, lastError: error })
      .where(and(eq(botChat.accountId, accountId), eq(botChat.bot, bot), eq(botChat.isReachable, true)))
      .returning({ id: botChat.id });
    return rows.length > 0;
  }

  async addConsent(data: Omit<ConsentRow, 'id' | 'createdAt' | 'acceptedAt'>): Promise<ConsentRow> {
    const rows = await this.txm.db
      .insert(consent)
      .values({ ...data, id: newId() })
      .returning();
    return rows[0]!;
  }
}
