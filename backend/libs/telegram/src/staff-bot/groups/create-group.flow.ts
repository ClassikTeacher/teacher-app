import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import { isValidGroupEmoji } from '@modules/people/groups/group-emoji.js';
import { GroupsUseCase, MAX_GROUP_NAME } from '@modules/people/groups/groups.use-case.js';
import { SubjectRepository } from '@modules/people/subject.repository.js';
import { LESSON_DURATION_OPTIONS } from '@modules/people/teacher-profile.defaults.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import type { BotContext } from '../../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../../core/flow.js';
import { escapeHtml, renderMenu, say } from '../../core/ui.js';
import { isTerminalFlowError } from '../common/flow-errors.js';
import { sectionCb } from '../section-module.js';

export interface CreateGroupData extends Record<string, unknown> {
  name: string;
  subjectId: string | null;
  emoji: string | null;
  defaultDurationMin: number | null;
}

/** UC-12 step 1: name → subject (teacher's subjects, optional) → emoji (optional) → duration (optional) → create. */
@Injectable()
export class CreateGroupFlow extends Flow<CreateGroupData> {
  readonly name = 'create-group';
  readonly firstStep = 'name';

  constructor(
    private readonly groups: GroupsUseCase,
    private readonly subjects: SubjectRepository,
    private readonly profiles: TeacherProfileRepository,
  ) {
    super();
  }

  async initial(): Promise<CreateGroupData> {
    return { name: '', subjectId: null, emoji: null, defaultDurationMin: null };
  }

  private async cancel(ctx: BotContext): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(
      ctx,
      ctx.t('cancel-done'),
      new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('groups', 'list')),
    );
    return { stay: true };
  }

  readonly steps: Record<string, FlowStep<CreateGroupData>> = {
    name: {
      enter: async (ctx) =>
        renderMenu(
          ctx,
          ctx.t('group-new-name'),
          new InlineKeyboard().text(ctx.t('btn-cancel'), flowCb('name', 'cancel')),
        ),
      onCallback: async (ctx, _d, action) => (action === 'cancel' ? this.cancel(ctx) : { stay: true }),
      onText: async (ctx, d, text) => {
        const name = text.trim();
        if (!name || name.length > MAX_GROUP_NAME) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_GROUP_NAME }));
          return { stay: true };
        }
        d.name = name;
        return { goto: 'subject' };
      },
    },
    subject: {
      enter: async (ctx) => {
        const active = await this.subjects.listActive();
        const profile = ctx.actor ? await this.profiles.find(ctx.actor.account.id) : null;
        const own = active.filter((s) => profile?.subjectIds.includes(s.id));
        const kb = new InlineKeyboard();
        for (const s of own.length > 0 ? own : active) kb.text(s.name, flowCb('subject', 'pick', s.id)).row();
        kb.text(ctx.t('btn-skip'), flowCb('subject', 'skip')).text(
          ctx.t('btn-cancel'),
          flowCb('subject', 'cancel'),
        );
        await renderMenu(ctx, ctx.t('group-new-subject'), kb);
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.cancel(ctx);
        if (action === 'skip') return { goto: 'emoji' };
        if (action === 'pick' && args[0] && (await this.subjects.findByIds([args[0]])).length === 1) {
          d.subjectId = args[0];
          return { goto: 'emoji' };
        }
        return { stay: true };
      },
    },
    emoji: {
      enter: async (ctx) =>
        renderMenu(
          ctx,
          ctx.t('group-new-emoji'),
          new InlineKeyboard().text(ctx.t('btn-skip'), flowCb('emoji', 'skip')),
        ),
      onCallback: async (_ctx, _d, action) => (action === 'skip' ? { goto: 'duration' } : { stay: true }),
      onText: async (ctx, d, text) => {
        if (!isValidGroupEmoji(text)) {
          await say(ctx, ctx.t('group-emoji-invalid'));
          return { stay: true };
        }
        d.emoji = text.trim();
        return { goto: 'duration' };
      },
    },
    duration: {
      enter: async (ctx) => {
        const kb = new InlineKeyboard();
        for (const min of LESSON_DURATION_OPTIONS) kb.text(`${min}`, flowCb('duration', 'dur', min));
        kb.row().text(ctx.t('btn-skip'), flowCb('duration', 'skip'));
        await renderMenu(ctx, ctx.t('group-new-duration'), kb);
      },
      onCallback: async (_ctx, d, action, args) => {
        if (action === 'skip') return { done: true };
        const n = Number(args[0]);
        if (action !== 'dur' || !Number.isInteger(n)) return { stay: true };
        d.defaultDurationMin = n;
        return { done: true };
      },
      onText: async (ctx, d, text) => {
        const n = /^\d{1,3}$/.test(text) ? Number(text) : NaN;
        if (!Number.isInteger(n) || n < 15 || n > 480) {
          await say(ctx, ctx.t('onb-duration-invalid'));
          return { stay: true };
        }
        d.defaultDurationMin = n;
        return { done: true };
      },
    },
  };

  async complete(ctx: BotContext, d: CreateGroupData): Promise<void | { goto: string }> {
    if (!ctx.actor) return;
    let group;
    try {
      group = await this.groups.create(ctx.actor.actor, d);
    } catch (error) {
      if (AppError.is(error, 'CONFLICT') && error.details?.['reason'] === 'duplicate_name') {
        // keep the typed data: back to the name step with an explanation
        await say(ctx, ctx.t('group-name-taken', { name: escapeHtml(d.name) }));
        return { goto: 'name' };
      }
      if (isTerminalFlowError(error)) ctx.session.flow = undefined;
      throw error;
    }
    const kb = new InlineKeyboard()
      .text(ctx.t('btn-group-members'), sectionCb('groups', 'members', group.id))
      .text(ctx.t('btn-back'), sectionCb('groups', 'card', group.id));
    await renderMenu(ctx, ctx.t('group-created', { name: group.name }), kb);
  }
}
