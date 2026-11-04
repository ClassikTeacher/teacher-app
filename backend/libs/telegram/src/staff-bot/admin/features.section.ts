import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import type { Actor } from '@modules/access/actor.js';
import {
  FEATURE_CATALOG,
  featureByIndex,
  featureIndex,
  limitNames,
} from '@modules/access/features/catalog.js';
import { FeatureAdminUseCase } from '@modules/access/features/feature-admin.use-case.js';
import { FeatureService } from '@modules/access/features/feature.service.js';
import { isUuid } from '@shared/ids/index.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import type { CreatedBot } from '../../core/bot-factory.js';
import type { BotContext } from '../../core/context.js';
import { escapeHtml, renderMenu } from '../../core/ui.js';
import { sectionCb, type StaffSectionModule } from '../section-module.js';
import { fullName } from './format.js';
import { LimitEditFlow } from './limit-edit.flow.js';

const ON = '🟢';
const OFF = '⚪️';

export function formatLimit(ctx: BotContext, name: string, value: number | null): string {
  if (value === null) return ctx.t('limit-none');
  if (name.endsWith('Bytes')) return `${Math.round(value / (1024 * 1024))} ${ctx.t('unit-mb')}`;
  return String(value);
}

/**
 * Admin → Фичи и лимиты (UC-07, 5.3.1). Every button carries its target and intended value
 * (`s:features:ton:<featureIdx>:<0|1>:<teacherId>`), so a stale button never acts on another screen.
 */
@Injectable()
export class FeaturesSection implements StaffSectionModule {
  readonly section = 'features' as const;

  constructor(
    private readonly features: FeatureService,
    private readonly admin: FeatureAdminUseCase,
    private readonly accounts: AccountRepository,
    private readonly limitFlow: LimitEditFlow,
  ) {}

  register({ flows }: CreatedBot): void {
    flows.register(this.limitFlow);
  }

  /** Global screen: the platform-wide switch per feature. */
  async open(ctx: BotContext, _actor: Actor): Promise<void> {
    const globals = await this.features.computeGlobal();
    const kb = new InlineKeyboard();
    for (const f of FEATURE_CATALOG.filter((f) => f.toggleable)) {
      const g = globals.get(f.key)!;
      const stage = f.stage > 1 ? ` (${ctx.t('feature-stage', { stage: f.stage })})` : '';
      const label = `${g.globalEnabled ? ON : OFF} ${ctx.t(`feature-${f.slug}`)}${stage}`;
      kb.text(label, sectionCb('features', 'gon', featureIndex(f.key), g.globalEnabled ? 0 : 1)).row();
    }
    kb.text(ctx.t('btn-back'), 'm:admin');
    await renderMenu(ctx, ctx.t('features-global', { on: ON, off: OFF }), kb);
  }

  async onCallback(ctx: BotContext, actor: Actor, action: string, args: string[]): Promise<void> {
    const definition = featureByIndex(args[0] ?? '');
    switch (action) {
      case 'teacher':
        return isUuid(args[0]) ? this.teacherScreen(ctx, args[0]) : this.open(ctx, actor);
      case 'gon': {
        if (!definition) return this.open(ctx, actor);
        await this.admin.setGlobal(actor, definition.key, { globalEnabled: args[1] === '1' });
        return this.open(ctx, actor);
      }
      case 'ton': {
        const teacherId = args[2];
        if (!definition || !isUuid(teacherId)) return this.open(ctx, actor);
        await this.admin.setTeacher(actor, teacherId, definition.key, { enabled: args[1] === '1' });
        return this.teacherScreen(ctx, teacherId);
      }
      case 'treset': {
        const teacherId = args[1];
        if (!definition || !isUuid(teacherId)) return this.open(ctx, actor);
        await this.admin.resetTeacher(actor, teacherId, definition.key);
        return this.teacherScreen(ctx, teacherId);
      }
      case 'lim': {
        const name = limitNames(definition ?? ({ defaultLimits: {} } as never))[Number(args[1])];
        const teacherId = args[2];
        if (!definition || !name || !isUuid(teacherId)) return this.open(ctx, actor);
        return this.limitFlow.start(ctx, { teacherId, key: definition.key, limitName: name });
      }
      default:
        return this.open(ctx, actor);
    }
  }

  async teacherScreen(ctx: BotContext, teacherId: string): Promise<void> {
    const teacher = await this.accounts.findById(teacherId);
    if (!teacher) return;
    const resolved = await this.features.compute(teacherId);
    const kb = new InlineKeyboard();
    for (const f of FEATURE_CATALOG) {
      const r = resolved.get(f.key)!;
      const idx = featureIndex(f.key);
      if (f.toggleable) {
        const suffix =
          r.reason === 'dependency'
            ? ' ⛓'
            : r.reason === 'global'
              ? ' 🔒'
              : r.personalEnabled !== null
                ? ' ✎'
                : '';
        kb.text(
          `${r.enabled ? ON : OFF} ${ctx.t(`feature-${f.slug}`)}${suffix}`,
          sectionCb('features', 'ton', idx, r.enabled ? 0 : 1, teacherId),
        );
        if (r.personalEnabled !== null) kb.text('↺', sectionCb('features', 'treset', idx, teacherId));
        kb.row();
      }
      limitNames(f).forEach((name, li) => {
        const label = `${ctx.t(`limit-${name}`)}: ${formatLimit(ctx, name, r.limits[name] ?? null)}`;
        kb.text(label, sectionCb('features', 'lim', idx, li, teacherId)).row();
      });
    }
    kb.text(ctx.t('btn-back'), sectionCb('teachers', 'card', teacherId));
    const text = ctx.t('features-teacher', { name: escapeHtml(fullName(teacher)), on: ON, off: OFF });
    await renderMenu(ctx, text, kb);
  }
}
