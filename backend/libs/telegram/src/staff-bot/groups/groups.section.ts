import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import type { Actor } from '@modules/access/actor.js';
import { type GroupDetails, GroupsQuery } from '@modules/people/groups/groups.query.js';
import { GroupsUseCase } from '@modules/people/groups/groups.use-case.js';
import type { CreatedBot } from '../../core/bot-factory.js';
import type { BotContext } from '../../core/context.js';
import { clip } from '../../core/format.js';
import { escapeHtml, renderMenu } from '../../core/ui.js';
import { resolveRef, shortRef } from '../common/short-ref.js';
import { sectionCb, type StaffSectionModule } from '../section-module.js';
import { CreateGroupFlow } from './create-group.flow.js';

/**
 * StaffBot → Группы (UC-12, 5.4.4): list, card, members (add from active students / remove), archive with
 * confirmation. Name/emoji/duration edits and schedule arrive with the REST client and M3.
 */
@Injectable()
export class GroupsSection implements StaffSectionModule {
  readonly section = 'groups' as const;

  constructor(
    private readonly query: GroupsQuery,
    private readonly groups: GroupsUseCase,
    private readonly createFlow: CreateGroupFlow,
  ) {}

  register({ flows }: CreatedBot): void {
    flows.register(this.createFlow);
  }

  async open(ctx: BotContext, actor: Actor): Promise<void> {
    const items = await this.query.listActive(actor.accountId);
    const kb = new InlineKeyboard();
    for (const { group, memberCount } of items) {
      const label = `${group.emoji ? `${group.emoji} ` : ''}${clip(group.name, 30)} · ${memberCount}`;
      kb.text(label, sectionCb('groups', 'card', group.id)).row();
    }
    kb.text(ctx.t('btn-add-group'), sectionCb('groups', 'create')).row();
    kb.text(ctx.t('btn-back'), 'm:main');
    await renderMenu(
      ctx,
      ctx.t(items.length > 0 ? 'groups-list' : 'groups-empty', { total: items.length }),
      kb,
    );
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    const id = args[0];
    switch (action) {
      case 'create':
        await this.groups.assertCanCreate(actor); // limit / feature reported before the dialog
        return this.createFlow.start(ctx);
      case 'card':
        return id ? this.card(ctx, actor, id) : this.open(ctx, actor);
      case 'members':
        return id ? this.members(ctx, actor, id) : this.open(ctx, actor);
      case 'add': // s:groups:add:<groupId>:<index>:<idSuffix> — a row of the candidates list
        if (id) await this.changeMembership(ctx, actor, id, args, 'add');
        return id ? this.members(ctx, actor, id) : this.open(ctx, actor);
      case 'remove': // s:groups:remove:<groupId>:<index>:<idSuffix> — a row of the members list
        if (id) await this.changeMembership(ctx, actor, id, args, 'remove');
        return id ? this.members(ctx, actor, id) : this.open(ctx, actor);
      case 'archive':
        return id ? this.confirmArchive(ctx, actor, id) : this.open(ctx, actor);
      case 'archiveok':
        if (id) await this.idempotent(ctx, () => this.groups.archive(actor, id));
        return this.open(ctx, actor);
      default:
        return this.open(ctx, actor);
    }
  }

  private async details(ctx: BotContext, actor: Actor, groupId: string): Promise<GroupDetails | null> {
    try {
      return await this.query.details(actor.accountId, groupId);
    } catch (error) {
      if (AppError.is(error, 'NOT_FOUND')) {
        await this.open(ctx, actor); // another teacher's group (8.0) or a vanished id
        return null;
      }
      throw error;
    }
  }

  private async card(ctx: BotContext, actor: Actor, groupId: string): Promise<void> {
    const d = await this.details(ctx, actor, groupId);
    if (!d) return;
    const kb = new InlineKeyboard();
    if (!d.group.archivedAt) {
      kb.text(ctx.t('btn-group-members'), sectionCb('groups', 'members', d.group.id))
        .text(ctx.t('btn-archive-group'), sectionCb('groups', 'archive', d.group.id))
        .row();
    }
    kb.text(ctx.t('btn-back'), sectionCb('groups', 'list'));
    const members =
      d.members.map((m) => `• ${escapeHtml(m.displayName)}`).join('\n') || ctx.t('group-no-members');
    await renderMenu(
      ctx,
      ctx.t('group-card', {
        name: escapeHtml(d.group.name),
        emoji: d.group.emoji ?? '',
        subject: d.subject ? escapeHtml(d.subject.name) : '—',
        duration:
          d.group.defaultDurationMin === null
            ? ctx.t('group-duration-default')
            : `${d.group.defaultDurationMin}`,
        count: d.members.length,
        members,
      }),
      kb,
    );
  }

  /** Members with remove buttons, then the teacher's other active students as add buttons (5.4.4). */
  private async members(ctx: BotContext, actor: Actor, groupId: string): Promise<void> {
    const d = await this.details(ctx, actor, groupId);
    if (!d) return;
    const candidates = await this.query.candidates(actor.accountId, groupId);
    const kb = new InlineKeyboard();
    d.members.forEach((m, i) =>
      kb
        .text(
          `➖ ${clip(m.displayName, 28)}`,
          sectionCb('groups', 'remove', groupId, ...shortRef(m.student.id, i)),
        )
        .row(),
    );
    candidates.forEach((c, i) =>
      kb
        .text(
          `➕ ${clip(c.displayName, 28)}`,
          sectionCb('groups', 'add', groupId, ...shortRef(c.student.id, i)),
        )
        .row(),
    );
    kb.text(ctx.t('btn-back'), sectionCb('groups', 'card', groupId));
    await renderMenu(
      ctx,
      ctx.t('group-members', { name: escapeHtml(d.group.name), count: d.members.length }),
      kb,
    );
  }

  private async confirmArchive(ctx: BotContext, actor: Actor, groupId: string): Promise<void> {
    const d = await this.details(ctx, actor, groupId);
    if (!d) return;
    const kb = new InlineKeyboard()
      .text(ctx.t('btn-confirm-archive'), sectionCb('groups', 'archiveok', groupId))
      .text(ctx.t('btn-cancel'), sectionCb('groups', 'card', groupId));
    await renderMenu(
      ctx,
      ctx.t('group-archive-confirm', { name: escapeHtml(d.group.name), count: d.members.length }),
      kb,
    );
  }

  /** Resolves the pressed row against the current list; a stale row (list changed) is refused. */
  private async changeMembership(
    ctx: BotContext,
    actor: Actor,
    groupId: string,
    args: string[],
    mode: 'add' | 'remove',
  ): Promise<void> {
    const d = await this.details(ctx, actor, groupId);
    if (!d) return;
    const rows =
      mode === 'add'
        ? (await this.query.candidates(actor.accountId, groupId)).map((c) => c.student.id)
        : d.members.map((m) => m.student.id);
    const studentId = resolveRef(rows, args[1], args[2], (id) => id);
    if (!studentId) {
      await ctx.answerCallbackQuery({ text: ctx.t('callback-stale') }).catch(() => undefined);
      return;
    }
    await this.idempotent(ctx, () =>
      mode === 'add'
        ? this.groups.addMember(actor, groupId, studentId)
        : this.groups.removeMember(actor, groupId, studentId),
    );
  }

  /** Double taps, stale buttons and a student who left meanwhile report a short notice instead of an error. */
  private async idempotent(ctx: BotContext, action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (AppError.is(error, 'CONFLICT')) {
        await ctx.answerCallbackQuery({ text: ctx.t('error-conflict') }).catch(() => undefined);
      } else if (AppError.is(error, 'LINK_NOT_ACTIVE') || AppError.is(error, 'NOT_FOUND')) {
        await ctx.answerCallbackQuery({ text: ctx.t('callback-stale') }).catch(() => undefined);
      } else {
        throw error;
      }
    }
  }
}
