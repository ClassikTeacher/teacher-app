import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import type { Actor } from '@modules/access/actor.js';
import { REMINDER_OFFSET_OPTIONS } from '@modules/notifications/delivery-policy.js';
import { NotificationSettingsUseCase } from '@modules/notifications/notification-settings.use-case.js';
import { CC_CONFIGURABLE_TYPES, isNotificationType } from '@modules/notifications/types.js';
import { cb } from '../core/callback.js';
import type { BotContext } from '../core/context.js';
import { SECTION_NS } from '../core/sections.js';
import { renderMenu } from '../core/ui.js';
import { NotificationEditFlow } from './notification-edit.flow.js';

const hhmm = (t: string): string => t.slice(0, 5);

/**
 * The «Уведомления» screens shared by the three bots (5.13.2–5.13.4): reminders (student, teacher), quiet
 * hours (everyone), the digest and copy defaults (teacher), mutes (everyone, parents for non-critical copies).
 * Callbacks are `s:<section>:n<action>[:arg]`; the owning section forwards every `n…` action to `handle`.
 */
@Injectable()
export class NotificationSettingsScreen {
  constructor(
    private readonly settings: NotificationSettingsUseCase,
    private readonly edit: NotificationEditFlow,
  ) {}

  private role(actor: Actor): 'teacher' | 'student' | 'parent' {
    if (actor.roles.includes('TEACHER')) return 'teacher';
    return actor.roles.includes('STUDENT') ? 'student' : 'parent';
  }

  private typeName(ctx: BotContext, code: string): string {
    return ctx.t('notif-type-name', { code: code.replace(/[._]/g, '-') });
  }

  async render(ctx: BotContext, actor: Actor, section: string, backCb: string): Promise<void> {
    const v = await this.settings.view(actor);
    const role = this.role(actor);
    const c = (action: string, ...args: Array<string | number>) => cb(SECTION_NS, section, action, ...args);
    const reminders =
      v.profile.reminderOffsetsMin.length > 0
        ? v.profile.reminderOffsetsMin.map((m) => ctx.t('notif-reminder-offset', { minutes: m })).join(', ')
        : ctx.t('notif-reminders-off');
    const quiet = v.profile.quietEnabled
      ? ctx.t('notif-quiet-range', { from: hhmm(v.profile.quietFrom), to: hhmm(v.profile.quietTo) })
      : ctx.t('notif-quiet-off');
    const muted = v.muted.map((t) => this.typeName(ctx, t)).join(', ') || ctx.t('notif-none');
    const kb = new InlineKeyboard();
    if (role !== 'parent') kb.text(ctx.t('btn-notif-reminders'), c('nrem'));
    kb.text(ctx.t('btn-notif-quiet'), c('nquiet')).row();
    if (role === 'teacher') {
      kb.text(ctx.t('btn-notif-digest'), c('ndig')).text(ctx.t('btn-notif-cc'), c('ncc')).row();
      kb.text(
        ctx.t(v.profile.deliverViaParent ? 'btn-notif-via-parent-on' : 'btn-notif-via-parent-off'),
        c('nvia'),
      ).row();
    }
    kb.text(ctx.t('btn-notif-mutes'), c('nmute')).row();
    // 5.14.2 (M6-04): the calendar subscription lives next to the notification settings of students and parents
    if (role !== 'teacher') kb.text(ctx.t('btn-ics'), c('ics')).row();
    kb.text(ctx.t('btn-back'), backCb);
    const text =
      role === 'teacher'
        ? ctx.t('notif-settings-teacher', {
            reminders,
            quiet,
            digest: v.profile.digestEnabled
              ? ctx.t('notif-digest-at', { time: hhmm(v.profile.digestTime) })
              : ctx.t('notif-digest-off'),
            cc:
              v.ccDefaults
                .filter((d) => d.enabled)
                .map((d) => this.typeName(ctx, d.type))
                .join(', ') || ctx.t('notif-none'),
            viaParent: v.profile.deliverViaParent ? 'on' : 'off',
          })
        : role === 'student'
          ? ctx.t('notif-settings-student', { reminders, quiet, muted })
          : ctx.t('notif-settings-parent', { quiet, muted });
    await renderMenu(ctx, text, kb);
  }

  /** Returns false for an action this screen does not own. */
  async handle(
    ctx: BotContext,
    actor: Actor,
    section: string,
    action: string,
    args: string[],
    backCb: string,
  ): Promise<boolean> {
    const c = (a: string, ...rest: Array<string | number>) => cb(SECTION_NS, section, a, ...rest);
    const main = c('nmain');
    switch (action) {
      case 'nmain':
        await this.render(ctx, actor, section, backCb);
        return true;
      case 'nrem':
        await this.reminders(ctx, actor, c, main);
        return true;
      case 'nremt': {
        const offset = Number(args[0]);
        if ((REMINDER_OFFSET_OPTIONS as readonly number[]).includes(offset)) {
          try {
            await this.settings.toggleOffset(actor, offset);
          } catch {
            await ctx.answerCallbackQuery({ text: ctx.t('notif-reminders-too-many') }).catch(() => undefined);
          }
        }
        await this.reminders(ctx, actor, c, main);
        return true;
      }
      case 'nquiet':
        await this.quiet(ctx, actor, c, main);
        return true;
      case 'nquiett':
        await this.settings.toggleQuiet(actor);
        await this.quiet(ctx, actor, c, main);
        return true;
      case 'nqedit':
        await this.edit.start(ctx, { field: 'quiet', backCb: main });
        return true;
      case 'ndig':
        await this.digest(ctx, actor, c, main);
        return true;
      case 'ndigt':
        await this.settings.toggleDigest(actor);
        await this.digest(ctx, actor, c, main);
        return true;
      case 'ndtime':
        await this.edit.start(ctx, { field: 'digestTime', backCb: main });
        return true;
      case 'nvia':
        await this.settings.toggleViaParent(actor);
        await this.render(ctx, actor, section, backCb);
        return true;
      case 'ncc':
        await this.ccDefaults(ctx, actor, c, main);
        return true;
      case 'ncct': {
        const type = CC_CONFIGURABLE_TYPES[Number(args[0])];
        if (type) await this.settings.toggleCcDefault(actor, type);
        await this.ccDefaults(ctx, actor, c, main);
        return true;
      }
      case 'nmute':
        await this.mutes(ctx, actor, c, main);
        return true;
      case 'nmutet': {
        const type = this.settings.muteable(actor)[Number(args[0])];
        if (type && isNotificationType(type)) await this.settings.toggleMute(actor, type);
        await this.mutes(ctx, actor, c, main);
        return true;
      }
      default:
        return false;
    }
  }

  private async reminders(
    ctx: BotContext,
    actor: Actor,
    c: (a: string, ...r: Array<string | number>) => string,
    main: string,
  ): Promise<void> {
    const v = await this.settings.view(actor);
    const kb = new InlineKeyboard();
    REMINDER_OFFSET_OPTIONS.forEach((m, i) => {
      const on = v.profile.reminderOffsetsMin.includes(m);
      kb.text(`${on ? '☑️' : '⬜'} ${ctx.t('notif-reminder-offset', { minutes: m })}`, c('nremt', m));
      if (i % 2 === 1) kb.row();
    });
    kb.text(ctx.t('btn-back'), main);
    await renderMenu(ctx, ctx.t('notif-reminders-prompt'), kb);
  }

  private async quiet(
    ctx: BotContext,
    actor: Actor,
    c: (a: string, ...r: Array<string | number>) => string,
    main: string,
  ): Promise<void> {
    const v = await this.settings.view(actor);
    const kb = new InlineKeyboard()
      .text(ctx.t(v.profile.quietEnabled ? 'btn-notif-quiet-on' : 'btn-notif-quiet-off'), c('nquiett'))
      .text(ctx.t('btn-notif-quiet-edit'), c('nqedit'))
      .row()
      .text(ctx.t('btn-back'), main);
    const text = v.profile.quietEnabled
      ? ctx.t('notif-quiet-range', { from: hhmm(v.profile.quietFrom), to: hhmm(v.profile.quietTo) })
      : ctx.t('notif-quiet-off');
    await renderMenu(ctx, `${ctx.t('btn-notif-quiet')}: ${text}`, kb);
  }

  private async digest(
    ctx: BotContext,
    actor: Actor,
    c: (a: string, ...r: Array<string | number>) => string,
    main: string,
  ): Promise<void> {
    const v = await this.settings.view(actor);
    const kb = new InlineKeyboard()
      .text(ctx.t(v.profile.digestEnabled ? 'btn-notif-digest-on' : 'btn-notif-digest-off'), c('ndigt'))
      .text(ctx.t('btn-notif-digest-time'), c('ndtime'))
      .row()
      .text(ctx.t('btn-back'), main);
    const text = v.profile.digestEnabled
      ? ctx.t('notif-digest-at', { time: hhmm(v.profile.digestTime) })
      : ctx.t('notif-digest-off');
    await renderMenu(ctx, `${ctx.t('btn-notif-digest')}: ${text}`, kb);
  }

  private async ccDefaults(
    ctx: BotContext,
    actor: Actor,
    c: (a: string, ...r: Array<string | number>) => string,
    main: string,
  ): Promise<void> {
    const v = await this.settings.view(actor);
    const kb = new InlineKeyboard();
    v.ccDefaults.forEach((d, i) =>
      kb.text(`${d.enabled ? '☑️' : '⬜'} ${this.typeName(ctx, d.type)}`, c('ncct', i)).row(),
    );
    kb.text(ctx.t('btn-back'), main);
    await renderMenu(ctx, ctx.t('notif-cc-prompt'), kb);
  }

  private async mutes(
    ctx: BotContext,
    actor: Actor,
    c: (a: string, ...r: Array<string | number>) => string,
    main: string,
  ): Promise<void> {
    const v = await this.settings.view(actor);
    const kb = new InlineKeyboard();
    this.settings.muteable(actor).forEach((type, i) => {
      const on = !v.muted.includes(type);
      kb.text(`${on ? '☑️' : '⬜'} ${this.typeName(ctx, type)}`, c('nmutet', i)).row();
    });
    kb.text(ctx.t('btn-back'), main);
    await renderMenu(ctx, ctx.t('notif-mutes-prompt'), kb);
  }
}
