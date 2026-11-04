import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { DateTime } from 'luxon';
import { AppError } from '@shared/errors/app-error.js';
import { Clock } from '@shared/time/clock.js';
import { AssignmentsUseCase } from '@modules/homework/assignments.use-case.js';
import { MAX_ASSIGNMENT_BODY_LENGTH, MAX_ASSIGNMENT_TITLE_LENGTH } from '@modules/homework/homework.rules.js';
import type { DueMode, SubmissionMode } from '@modules/homework/schema.js';
import { GroupsQuery } from '@modules/people/groups/groups.query.js';
import { cardDisplayName, TeacherStudentsQuery } from '@modules/people/links/students.query.js';
import type { BotContext } from '../../core/context.js';
import { Flow, flowCb, type FlowNext, type FlowStep } from '../../core/flow.js';
import { clip } from '../../core/format.js';
import { escapeHtml, renderMenu, say } from '../../core/ui.js';
import { isTerminalFlowError } from '../common/flow-errors.js';
import { resolveRef, shortRef } from '../common/short-ref.js';
import { sectionCb } from '../section-module.js';

export interface CreateAssignmentPreset {
  lessonId: string | null;
  studentIds: string[];
  groupIds: string[];
}

export interface CreateAssignmentData extends Record<string, unknown>, CreateAssignmentPreset {
  title: string | null;
  body: string | null;
  dueMode: DueMode;
  dueAt: string | null;
  mode: SubmissionMode;
  acceptLate: boolean;
  allowResubmit: boolean;
  /** Ids shown on the «who» screen, for short refs. */
  shownStudents: string[];
  shownGroups: string[];
}

const DUE_FORMAT = 'dd.MM.yyyy HH:mm';
const MODES: SubmissionMode[] = ['files_text', 'text', 'files', 'mark', 'none'];
const MODE_KEYS: Record<SubmissionMode, string> = {
  files_text: 'btn-mode-files-text',
  text: 'btn-mode-text',
  files: 'btn-mode-files',
  mark: 'btn-mode-mark',
  none: 'btn-mode-none',
};

/** UC-26: title → body → addressees → due → submission mode → confirm (late / resubmission toggles) → publish. */
@Injectable()
export class CreateAssignmentFlow extends Flow<CreateAssignmentData> {
  readonly name = 'create-assignment';
  readonly firstStep = 'title';

  constructor(
    private readonly assignments: AssignmentsUseCase,
    private readonly students: TeacherStudentsQuery,
    private readonly groups: GroupsQuery,
    private readonly clock: Clock,
  ) {
    super();
  }

  async initial(_ctx: BotContext, arg: unknown): Promise<CreateAssignmentData> {
    const preset = (arg as Partial<CreateAssignmentPreset> | undefined) ?? {};
    return {
      lessonId: preset.lessonId ?? null,
      studentIds: preset.studentIds ?? [],
      groupIds: preset.groupIds ?? [],
      title: null,
      body: null,
      dueMode: 'next_lesson',
      dueAt: null,
      mode: 'files_text',
      acceptLate: true,
      allowResubmit: true,
      shownStudents: [],
      shownGroups: [],
    };
  }

  private back(ctx: BotContext): InlineKeyboard {
    return new InlineKeyboard().text(ctx.t('btn-back'), sectionCb('assignments', 'list'));
  }

  private async cancel(ctx: BotContext): Promise<FlowNext> {
    ctx.session.flow = undefined;
    await renderMenu(ctx, ctx.t('cancel-done'), this.back(ctx));
    return { stay: true };
  }

  private zone(ctx: BotContext): string {
    return ctx.actor?.account.timezone ?? 'UTC';
  }

  readonly steps: Record<string, FlowStep<CreateAssignmentData>> = {
    title: {
      enter: async (ctx) =>
        renderMenu(
          ctx,
          ctx.t('newhw-ask-title'),
          new InlineKeyboard().text(ctx.t('btn-cancel'), flowCb('title', 'cancel')),
        ),
      onCallback: async (ctx, _d, action) => (action === 'cancel' ? this.cancel(ctx) : { stay: true }),
      onText: async (ctx, d, text) => {
        if (!text || text.length > MAX_ASSIGNMENT_TITLE_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_ASSIGNMENT_TITLE_LENGTH }));
          return { stay: true };
        }
        d.title = text;
        return { goto: 'body' };
      },
    },
    body: {
      enter: async (ctx) =>
        renderMenu(
          ctx,
          ctx.t('newhw-ask-body'),
          new InlineKeyboard()
            .text(ctx.t('btn-skip'), flowCb('body', 'skip'))
            .text(ctx.t('btn-cancel'), flowCb('body', 'cancel')),
        ),
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.cancel(ctx);
        if (action !== 'skip') return { stay: true };
        return d.studentIds.length + d.groupIds.length > 0 ? { goto: 'due' } : { goto: 'who' };
      },
      onText: async (ctx, d, text) => {
        if (text.length > MAX_ASSIGNMENT_BODY_LENGTH) {
          await say(ctx, ctx.t('text-too-long', { max: MAX_ASSIGNMENT_BODY_LENGTH }));
          return { stay: true };
        }
        d.body = text;
        return d.studentIds.length + d.groupIds.length > 0 ? { goto: 'due' } : { goto: 'who' };
      },
    },
    who: {
      enter: async (ctx, d) => {
        const teacherId = ctx.actor!.actor.accountId;
        const [students, groups] = await Promise.all([
          this.students.listActive(teacherId),
          this.groups.listActive(teacherId),
        ]);
        d.shownStudents = students.map((s) => s.link.studentId!);
        d.shownGroups = groups.map((g) => g.group.id);
        const kb = new InlineKeyboard();
        groups.slice(0, 10).forEach((g, i) => {
          const on = d.groupIds.includes(g.group.id) ? '✅ ' : '';
          kb.text(`${on}👥 ${clip(g.group.name, 28)}`, flowCb('who', 'g', ...shortRef(g.group.id, i))).row();
        });
        students.slice(0, 20).forEach((s, i) => {
          const on = d.studentIds.includes(s.link.studentId!) ? '✅ ' : '';
          kb.text(
            `${on}${clip(cardDisplayName(s), 28)}`,
            flowCb('who', 's', ...shortRef(s.link.studentId!, i)),
          ).row();
        });
        kb.text(ctx.t('btn-next'), flowCb('who', 'next')).text(ctx.t('btn-cancel'), flowCb('who', 'cancel'));
        await renderMenu(ctx, ctx.t('newhw-ask-who'), kb);
      },
      onCallback: async (ctx, d, action, args) => {
        if (action === 'cancel') return this.cancel(ctx);
        if (action === 'next') {
          if (d.studentIds.length + d.groupIds.length === 0) {
            await ctx.answerCallbackQuery({ text: ctx.t('newhw-no-one') }).catch(() => undefined);
            return { stay: true };
          }
          return { goto: 'due' };
        }
        const toggle = (list: string[], id: string) =>
          list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
        if (action === 's') {
          const id = resolveRef(d.shownStudents, args[0], args[1], (x) => x);
          if (id) d.studentIds = toggle(d.studentIds, id);
          return { goto: 'who' };
        }
        if (action === 'g') {
          const id = resolveRef(d.shownGroups, args[0], args[1], (x) => x);
          if (id) d.groupIds = toggle(d.groupIds, id);
          return { goto: 'who' };
        }
        return { stay: true };
      },
    },
    due: {
      enter: async (ctx) =>
        renderMenu(
          ctx,
          ctx.t('newhw-ask-due'),
          new InlineKeyboard()
            .text(ctx.t('btn-due-next-lesson'), flowCb('due', 'next'))
            .text(ctx.t('btn-due-none'), flowCb('due', 'none'))
            .row()
            .text(ctx.t('btn-cancel'), flowCb('due', 'cancel')),
        ),
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.cancel(ctx);
        if (action === 'next') d.dueMode = 'next_lesson';
        else if (action === 'none') d.dueMode = 'none';
        else return { stay: true };
        d.dueAt = null;
        return { goto: 'mode' };
      },
      onText: async (ctx, d, text) => {
        const parsed = DateTime.fromFormat(text.trim(), DUE_FORMAT, { zone: this.zone(ctx) });
        if (!parsed.isValid || parsed.toJSDate().getTime() <= this.clock.now().getTime()) {
          await say(ctx, ctx.t('newhw-bad-due'));
          return { stay: true };
        }
        d.dueMode = 'fixed';
        d.dueAt = parsed.toUTC().toISO();
        return { goto: 'mode' };
      },
    },
    mode: {
      enter: async (ctx) => {
        const kb = new InlineKeyboard();
        for (const m of MODES) kb.text(ctx.t(MODE_KEYS[m]), flowCb('mode', m)).row();
        kb.text(ctx.t('btn-cancel'), flowCb('mode', 'cancel'));
        await renderMenu(ctx, ctx.t('newhw-ask-mode'), kb);
      },
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.cancel(ctx);
        if (!MODES.includes(action as SubmissionMode)) return { stay: true };
        d.mode = action as SubmissionMode;
        return { goto: 'confirm' };
      },
    },
    confirm: {
      enter: async (ctx, d) => {
        const kb = new InlineKeyboard()
          .text(ctx.t('btn-toggle-late', { value: d.acceptLate ? 'yes' : 'no' }), flowCb('confirm', 'late'))
          .text(
            ctx.t('btn-toggle-resubmit', { value: d.allowResubmit ? 'yes' : 'no' }),
            flowCb('confirm', 'resubmit'),
          )
          .row()
          .text(ctx.t('btn-publish-assignment'), flowCb('confirm', 'publish'))
          .text(ctx.t('btn-cancel'), flowCb('confirm', 'cancel'));
        await renderMenu(ctx, await this.confirmText(ctx, d), kb);
      },
      onCallback: async (ctx, d, action) => {
        if (action === 'cancel') return this.cancel(ctx);
        if (action === 'late') {
          d.acceptLate = !d.acceptLate;
          return { goto: 'confirm' };
        }
        if (action === 'resubmit') {
          d.allowResubmit = !d.allowResubmit;
          return { goto: 'confirm' };
        }
        return action === 'publish' ? { done: true } : { stay: true };
      },
    },
  };

  private async confirmText(ctx: BotContext, d: CreateAssignmentData): Promise<string> {
    const teacherId = ctx.actor!.actor.accountId;
    const [students, groups] = await Promise.all([
      this.students.listActive(teacherId),
      this.groups.listActive(teacherId),
    ]);
    const who = [
      ...groups.filter((g) => d.groupIds.includes(g.group.id)).map((g) => `👥 ${g.group.name}`),
      ...students.filter((s) => d.studentIds.includes(s.link.studentId!)).map((s) => cardDisplayName(s)),
    ].join(', ');
    const due = ctx.t('assignment-due', {
      mode: d.dueMode,
      due: d.dueAt ? DateTime.fromISO(d.dueAt, { zone: this.zone(ctx) }).toFormat(DUE_FORMAT) : '',
    });
    return ctx.t('newhw-confirm', {
      title: escapeHtml(d.title ?? ''),
      who: escapeHtml(who || '—'),
      due,
      mode: ctx.t('submission-mode', { mode: d.mode }),
      late: d.acceptLate ? 'yes' : 'no',
      resubmit: d.allowResubmit ? 'yes' : 'no',
    });
  }

  async complete(ctx: BotContext, d: CreateAssignmentData): Promise<void> {
    if (!ctx.actor || !d.title) {
      ctx.session.flow = undefined;
      return;
    }
    try {
      const row = await this.assignments.create(ctx.actor.actor, {
        title: d.title,
        body: d.body,
        dueMode: d.dueMode,
        dueAt: d.dueAt ? new Date(d.dueAt) : null,
        assignedLessonId: d.lessonId,
        submissionMode: d.mode,
        submissionRules: { acceptLate: d.acceptLate, allowResubmit: d.allowResubmit },
        studentIds: d.studentIds,
        groupIds: d.groupIds,
      });
      const count = row.status === 'published' ? await this.countTargets(ctx, row.id) : 0;
      await renderMenu(
        ctx,
        ctx.t('newhw-done', { title: escapeHtml(row.title), count }),
        new InlineKeyboard().text(ctx.t('btn-open'), sectionCb('assignments', 'a', row.id)),
      );
    } catch (error) {
      if (AppError.is(error, 'VALIDATION_ERROR') && error.details?.['reason'] === 'due_in_past') {
        await say(ctx, ctx.t('newhw-bad-due'));
        return;
      }
      if (isTerminalFlowError(error)) ctx.session.flow = undefined;
      throw error;
    }
  }

  private async countTargets(ctx: BotContext, assignmentId: string): Promise<number> {
    const card = await this.assignments.own(ctx.actor!.actor, assignmentId);
    void card;
    return (await this.assignments['repo'].listTargets(assignmentId)).length;
  }
}
