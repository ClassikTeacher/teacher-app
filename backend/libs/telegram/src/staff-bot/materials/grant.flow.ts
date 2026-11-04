import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { DateTime } from 'luxon';
import { GrantsUseCase } from '@modules/content/grants.use-case.js';
import type { GrantSubjectType } from '@modules/content/schema.js';
import { GroupsQuery } from '@modules/people/groups/groups.query.js';
import { cardDisplayName, TeacherStudentsQuery } from '@modules/people/links/students.query.js';
import type { BotContext } from '../../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../../core/flow.js';
import { clip } from '../../core/format.js';
import { escapeHtml, renderMenu, say } from '../../core/ui.js';
import { isTerminalFlowError } from '../common/flow-errors.js';
import { resolveRef, shortRef } from '../common/short-ref.js';
import { sectionCb } from '../section-module.js';

export interface GrantPreset {
  subjectType: GrantSubjectType;
  subjectId: string;
  title: string;
  /** Offered right after an upload: «Позже» is allowed. */
  optional?: boolean;
  /** Where to return afterwards. */
  backCb?: string;
}

export interface GrantData extends Record<string, unknown>, GrantPreset {
  studentIds: string[];
  groupIds: string[];
  grantee: { studentId: string } | { groupId: string } | null;
  granteeLabel: string | null;
  availableFrom: string | null;
}

const DATE_FORMAT = 'dd.MM.yyyy';

/** 5.9.3: pick a student or a group, then «сейчас» or a date of opening; one grant per dialog. */
@Injectable()
export class GrantFlow extends Flow<GrantData> {
  readonly name = 'grant';
  readonly firstStep = 'who';

  constructor(
    private readonly grants: GrantsUseCase,
    private readonly students: TeacherStudentsQuery,
    private readonly groups: GroupsQuery,
  ) {
    super();
  }

  async initial(ctx: BotContext, arg: unknown): Promise<GrantData> {
    const preset = arg as GrantPreset;
    const teacherId = ctx.actor!.actor.accountId;
    const [students, groups] = await Promise.all([
      this.students.listActive(teacherId),
      this.groups.listActive(teacherId),
    ]);
    return {
      ...preset,
      studentIds: students.map((s) => s.link.studentId!),
      groupIds: groups.map((g) => g.group.id),
      grantee: null,
      granteeLabel: null,
      availableFrom: null,
    };
  }

  private back(ctx: BotContext, d: GrantData): InlineKeyboard {
    return new InlineKeyboard().text(ctx.t('btn-back'), d.backCb ?? sectionCb('materials', 'list'));
  }

  private async leave(ctx: BotContext, d: GrantData, key: string): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(ctx, ctx.t(key), this.back(ctx, d));
    return { stay: true };
  }

  readonly steps: Record<string, FlowStep<GrantData>> = {
    who: {
      enter: async (ctx, d) => {
        const teacherId = ctx.actor!.actor.accountId;
        const [students, groups] = await Promise.all([
          this.students.listActive(teacherId),
          this.groups.listActive(teacherId),
        ]);
        d.studentIds = students.map((s) => s.link.studentId!);
        d.groupIds = groups.map((g) => g.group.id);
        const kb = new InlineKeyboard();
        groups
          .slice(0, 10)
          .forEach((g, i) =>
            kb.text(`👥 ${clip(g.group.name, 30)}`, flowCb('who', 'g', ...shortRef(g.group.id, i))).row(),
          );
        students
          .slice(0, 20)
          .forEach((s, i) =>
            kb
              .text(clip(cardDisplayName(s), 30), flowCb('who', 's', ...shortRef(s.link.studentId!, i)))
              .row(),
          );
        if (d.optional) kb.text(ctx.t('btn-grant-later'), flowCb('who', 'later'));
        kb.text(ctx.t('btn-cancel'), flowCb('who', 'cancel'));
        await renderMenu(ctx, ctx.t('grant-pick', { title: escapeHtml(d.title) }), kb);
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.leave(ctx, d, 'cancel-done');
        if (action === 'later') return this.leave(ctx, d, 'grant-later-ok');
        if (action === 's') {
          const id = resolveRef(d.studentIds, args[0], args[1], (x) => x);
          if (!id) return { stay: true };
          const item = (await this.students.listActive(ctx.actor!.actor.accountId)).find(
            (s) => s.link.studentId === id,
          );
          d.grantee = { studentId: id };
          d.granteeLabel = item ? cardDisplayName(item) : '—';
          return { goto: 'when' };
        }
        if (action === 'g') {
          const id = resolveRef(d.groupIds, args[0], args[1], (x) => x);
          if (!id) return { stay: true };
          const item = (await this.groups.listActive(ctx.actor!.actor.accountId)).find(
            (g) => g.group.id === id,
          );
          d.grantee = { groupId: id };
          d.granteeLabel = item ? item.group.name : '—';
          return { goto: 'when' };
        }
        return { stay: true };
      },
    },
    when: {
      enter: async (ctx, d) =>
        renderMenu(
          ctx,
          ctx.t('grant-when', { who: escapeHtml(d.granteeLabel ?? '') }),
          new InlineKeyboard()
            .text(ctx.t('btn-grant-now'), flowCb('when', 'now'))
            .text(ctx.t('btn-cancel'), flowCb('when', 'cancel')),
        ),
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.leave(ctx, d, 'cancel-done');
        if (action !== 'now') return { stay: true };
        d.availableFrom = null;
        return { done: true };
      },
      onText: async (ctx, d, text) => {
        const zone = ctx.actor?.account.timezone ?? 'UTC';
        const parsed = DateTime.fromFormat(text.trim(), DATE_FORMAT, { zone });
        if (!parsed.isValid) {
          await say(ctx, ctx.t('grant-bad-date'));
          return { stay: true };
        }
        d.availableFrom = parsed.startOf('day').toUTC().toISO();
        return { done: true };
      },
    },
  };

  async complete(ctx: BotContext, d: GrantData): Promise<void> {
    if (!ctx.actor || !d.grantee) {
      ctx.session.flow = undefined;
      return;
    }
    try {
      const { studentIds } = await this.grants.grant(ctx.actor.actor, {
        subjectType: d.subjectType,
        subjectId: d.subjectId,
        grantee: d.grantee,
        availableFrom: d.availableFrom ? new Date(d.availableFrom) : null,
      });
      const from = d.availableFrom
        ? ctx.t('grant-opens', {
            date: DateTime.fromISO(d.availableFrom, { zone: ctx.actor.account.timezone }).toFormat(
              DATE_FORMAT,
            ),
          })
        : '';
      await renderMenu(
        ctx,
        ctx.t('grant-done', { who: escapeHtml(d.granteeLabel ?? ''), count: studentIds.length, from }),
        this.back(ctx, d),
      );
    } catch (error) {
      if (isTerminalFlowError(error)) ctx.session.flow = undefined;
      throw error;
    }
  }
}
