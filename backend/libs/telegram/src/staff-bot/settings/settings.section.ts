import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { isUuid } from '@shared/ids/index.js';
import type { Actor } from '@modules/access/actor.js';
import { SubjectRepository } from '@modules/people/subject.repository.js';
import { type TeacherSettings, TeacherSettingsUseCase } from '@modules/people/teacher-settings.use-case.js';
import type { CreatedBot } from '../../core/bot-factory.js';
import type { BotContext } from '../../core/context.js';
import { clip, fullName } from '../../core/format.js';
import { escapeHtml, renderMenu } from '../../core/ui.js';
import { subjectByRef, subjectPickerKeyboard, subjectRef } from '../common/subject-picker.js';
import { backKeyboard } from '../menu.js';
import { sectionCb, type StaffSectionModule } from '../section-module.js';
import { isSettingField, SettingEditFlow } from './setting-edit.flow.js';
import { AddExceptionFlow } from './add-exception.flow.js';
import { AddRuleFlow } from './add-rule.flow.js';
import { NotificationEditFlow } from '../../person/notification-edit.flow.js';
import { NotificationSettingsScreen } from '../../person/notification-settings.screen.js';
import { BookingSettingsScreen } from './booking.screen.js';
import { WindowsScreen } from './windows.screen.js';

/**
 * StaffBot → Настройки (4.4, M2-04): profile and subjects, buffers, cancellation permissions, default notice
 * text, reason templates. Windows and the open calendar arrive with M3, notifications and copies with M4.
 */
@Injectable()
export class SettingsSection implements StaffSectionModule {
  readonly section = 'settings' as const;

  constructor(
    private readonly settings: TeacherSettingsUseCase,
    private readonly subjects: SubjectRepository,
    private readonly editFlow: SettingEditFlow,
    private readonly windows: WindowsScreen,
    private readonly booking: BookingSettingsScreen,
    private readonly notifications: NotificationSettingsScreen,
    private readonly notificationEdit: NotificationEditFlow,
    private readonly addRule: AddRuleFlow,
    private readonly addException: AddExceptionFlow,
  ) {}

  register({ flows }: CreatedBot): void {
    flows
      .register(this.editFlow)
      .register(this.addRule)
      .register(this.addException)
      .register(this.notificationEdit);
  }

  async open(ctx: BotContext, actor: Actor): Promise<void> {
    const s = await this.settings.get(actor);
    const subjects = await this.subjects.findByIds(s.profile.subjectIds);
    const kb = new InlineKeyboard()
      .text(ctx.t('btn-set-name'), sectionCb('settings', 'edit', 'name'))
      .text(ctx.t('btn-set-timezone'), sectionCb('settings', 'edit', 'timezone'))
      .row()
      .text(ctx.t('btn-set-subjects'), sectionCb('settings', 'subjects'))
      .text(ctx.t('btn-set-duration'), sectionCb('settings', 'edit', 'defaultDurationMin'))
      .row()
      .text(ctx.t('btn-set-buffers'), sectionCb('settings', 'buffers'))
      .text(ctx.t('btn-set-cancel'), sectionCb('settings', 'cancel'))
      .row()
      .text(ctx.t('btn-set-notice'), sectionCb('settings', 'edit', 'defaultNoticeText'))
      .text(ctx.t('btn-set-templates'), sectionCb('settings', 'templates'))
      .row()
      .text(ctx.t('btn-set-windows'), sectionCb('settings', 'windows'))
      .text(ctx.t('btn-set-booking'), sectionCb('settings', 'booking'))
      .row()
      .text(ctx.t('btn-set-notifications'), sectionCb('settings', 'notifications'))
      .row()
      .text(ctx.t('btn-back'), 'm:main');
    await renderMenu(
      ctx,
      this.summary(
        ctx,
        s,
        subjects.map((x) => x.name),
      ),
      kb,
    );
  }

  private summary(ctx: BotContext, s: TeacherSettings, subjects: string[]): string {
    const { account, profile } = s;
    const cutoff =
      profile.studentCancelCutoffHours === null
        ? ctx.t('cutoff-until-start')
        : ctx.t('hours', { n: profile.studentCancelCutoffHours });
    return ctx.t('settings-summary', {
      name: escapeHtml(fullName(account)),
      username: account.username ? `@${escapeHtml(account.username)}` : '—',
      timezone: escapeHtml(account.timezone),
      subjects: escapeHtml(subjects.join(', ') || '—'),
      duration: profile.defaultDurationMin,
      before: profile.bufferBeforeMin,
      after: profile.bufferAfterMin,
      studentCancel: ctx.t(profile.studentCanCancel ? 'on' : 'off'),
      parentCancel: ctx.t(profile.parentCanCancel ? 'on' : 'off'),
      cutoff,
      late: profile.lateCancelHours,
      notice: escapeHtml(clip(profile.defaultNoticeText, 120)),
    });
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    if (
      action.startsWith('n') &&
      (await this.notifications.handle(ctx, actor, 'settings', action, args, sectionCb('settings', 'main')))
    )
      return;
    const arg = args[0];
    switch (action) {
      case 'edit':
        return arg && isSettingField(arg) ? this.editFlow.start(ctx, { field: arg }) : this.open(ctx, actor);
      case 'subjects':
        return this.subjectsScreen(ctx, actor);
      case 'subj': // s:settings:subj:<index>:<idSuffix>
        await this.toggleSubject(ctx, actor, args);
        return this.subjectsScreen(ctx, actor);
      case 'buffers':
        return this.buffersScreen(ctx, actor);
      case 'cancel':
        return this.cancelScreen(ctx, actor);
      case 'toggle':
        if (arg === 'student' || arg === 'parent') await this.toggleCancel(actor, arg);
        return this.cancelScreen(ctx, actor);
      case 'templates':
        return this.templatesScreen(ctx, actor);
      case 'tdel':
        if (arg) await this.settings.removeTemplate(actor, arg);
        return this.templatesScreen(ctx, actor);
      case 'windows':
        return this.windows.render(ctx, actor);
      case 'wradd':
        return this.addRule.start(ctx);
      case 'weadd': // s:settings:weadd:closed|extra
        return this.addException.start(ctx, { kind: arg === 'extra' ? 'extra' : 'closed' });
      case 'wrdel':
        if (isUuid(arg)) await this.windows.remove(ctx, actor, 'rule', arg);
        return this.windows.render(ctx, actor);
      case 'wedel':
        if (isUuid(arg)) await this.windows.remove(ctx, actor, 'exception', arg);
        return this.windows.render(ctx, actor);
      case 'wmode':
        await this.windows.toggleMode(actor);
        return this.windows.render(ctx, actor);
      case 'booking': // 5.5.5 booking rules
        return this.booking.render(ctx, actor);
      case 'notifications': // 5.13 (M4-05)
        return this.notifications.render(ctx, actor, 'settings', sectionCb('settings', 'main'));
      case 'bconf':
        await this.booking.toggleConfirmation(actor);
        return this.booking.render(ctx, actor);
      case 'bstep':
        await this.booking.cycleStep(actor);
        return this.booking.render(ctx, actor);
      case 'soon':
        return renderMenu(ctx, ctx.t('settings-soon'), backKeyboard(ctx, 'main'));
      default:
        return this.open(ctx, actor);
    }
  }

  private async subjectsScreen(ctx: BotContext, actor: Actor): Promise<void> {
    const [s, active] = await Promise.all([this.settings.get(actor), this.subjects.listActive()]);
    const kb = subjectPickerKeyboard(
      ctx,
      active,
      s.profile.subjectIds,
      (_subject, index) => sectionCb('settings', 'subj', ...subjectRef(active, index)),
      sectionCb('settings', 'main'),
    );
    await renderMenu(ctx, ctx.t('settings-subjects'), kb);
  }

  /** Atomic add/remove under the profile lock; the last subject cannot be removed; stale references are refused. */
  private async toggleSubject(ctx: BotContext, actor: Actor, args: string[]): Promise<void> {
    const subject = subjectByRef(await this.subjects.listActive(), args[0], args[1]);
    if (!subject) {
      await ctx.answerCallbackQuery({ text: ctx.t('callback-stale') }).catch(() => undefined);
      return;
    }
    const { profile } = await this.settings.get(actor);
    if (profile.subjectIds.includes(subject.id) && profile.subjectIds.length === 1) {
      await ctx.answerCallbackQuery({ text: ctx.t('onb-subjects-required') }).catch(() => undefined);
      return;
    }
    await this.settings.toggleSubject(actor, subject.id);
  }

  private async buffersScreen(ctx: BotContext, actor: Actor): Promise<void> {
    const s = await this.settings.get(actor);
    const kb = new InlineKeyboard()
      .text(
        ctx.t('btn-buffer-before', { n: s.profile.bufferBeforeMin }),
        sectionCb('settings', 'edit', 'bufferBeforeMin'),
      )
      .text(
        ctx.t('btn-buffer-after', { n: s.profile.bufferAfterMin }),
        sectionCb('settings', 'edit', 'bufferAfterMin'),
      )
      .row()
      .text(ctx.t('btn-back'), sectionCb('settings', 'main'));
    await renderMenu(ctx, ctx.t('settings-buffers'), kb);
  }

  private async cancelScreen(ctx: BotContext, actor: Actor): Promise<void> {
    const { profile } = await this.settings.get(actor);
    const state = (on: boolean): string => (on ? '🟢' : '⚪️');
    const kb = new InlineKeyboard()
      .text(
        ctx.t('btn-student-cancel', { state: state(profile.studentCanCancel) }),
        sectionCb('settings', 'toggle', 'student'),
      )
      .row()
      .text(
        ctx.t('btn-parent-cancel', { state: state(profile.parentCanCancel) }),
        sectionCb('settings', 'toggle', 'parent'),
      )
      .row()
      .text(ctx.t('btn-cutoff'), sectionCb('settings', 'edit', 'studentCancelCutoffHours'))
      .text(ctx.t('btn-late-hours'), sectionCb('settings', 'edit', 'lateCancelHours'))
      .row()
      .text(ctx.t('btn-back'), sectionCb('settings', 'main'));
    await renderMenu(ctx, ctx.t('settings-cancel'), kb);
  }

  private async toggleCancel(actor: Actor, who: 'student' | 'parent'): Promise<void> {
    const { profile } = await this.settings.get(actor);
    await this.settings.update(
      actor,
      who === 'student'
        ? { studentCanCancel: !profile.studentCanCancel }
        : { parentCanCancel: !profile.parentCanCancel },
    );
  }

  private async templatesScreen(ctx: BotContext, actor: Actor): Promise<void> {
    const rows = await this.settings.listTemplates(actor, 'cancel_reason');
    const kb = new InlineKeyboard();
    const lines = rows.map((t, i) => {
      kb.text(`🗑 ${i + 1}`, sectionCb('settings', 'tdel', t.id));
      if (i % 4 === 3) kb.row();
      return `${i + 1}. ${escapeHtml(t.text)}`;
    });
    if (rows.length % 4 !== 0) kb.row();
    kb.text(ctx.t('btn-add-template'), sectionCb('settings', 'edit', 'template')).row();
    kb.text(ctx.t('btn-back'), sectionCb('settings', 'main'));
    const body = lines.length > 0 ? lines.join('\n') : ctx.t('templates-empty');
    await renderMenu(ctx, `${ctx.t('templates-title')}\n\n${body}`, kb);
  }
}
