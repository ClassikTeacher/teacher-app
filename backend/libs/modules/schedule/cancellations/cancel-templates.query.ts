import { Injectable } from '@nestjs/common';
import { type Actor, assertActive } from '@modules/access/actor.js';
import { MessageTemplateRepository } from '@modules/people/message-template.repository.js';
import { TeacherProfileRepository } from '@modules/people/teacher-profile.repository.js';
import { NotificationRenderer } from '@modules/notifications/render.js';
import { STARTER_TEMPLATE_COUNT } from './cancel.rules.js';

export interface CancelTemplate {
  /** Null for a starter text or the teacher's default notice (not a `message_template` row). */
  id: string | null;
  text: string;
  /** The teacher's text by default (Р-23): preselected when cancelling, sent when nothing else is chosen. */
  isDefault: boolean;
}

/**
 * 5.7.2: reason templates offered in the cancel dialog. A teacher gets their default notice first, then their own
 * templates (or the starter set while they have none); a student or a parent gets their own templates or the
 * starter set. Persisted templates are managed in the settings (`TeacherSettingsUseCase`).
 */
@Injectable()
export class CancelTemplatesQuery {
  constructor(
    private readonly templates: MessageTemplateRepository,
    private readonly profiles: TeacherProfileRepository,
  ) {}

  private readonly labels = new NotificationRenderer();

  async forActor(
    actor: Actor,
    role: 'TEACHER' | 'STUDENT' | 'PARENT',
    locale = 'ru',
  ): Promise<CancelTemplate[]> {
    assertActive(actor);
    const own = (await this.templates.listActive(actor.accountId, 'cancel_reason')).map((r) => ({
      id: r.id,
      text: r.text,
      isDefault: false,
    }));
    const prefix = role === 'TEACHER' ? 'cancel-template-teacher' : 'cancel-template-person';
    const starter = Array.from({ length: STARTER_TEMPLATE_COUNT }, (_, i) => ({
      id: null,
      text: this.labels.t(`${prefix}-${i + 1}`, locale),
      isDefault: false,
    }));
    const list = own.length > 0 ? own : starter;
    if (role !== 'TEACHER') return list;
    const profile = await this.profiles.find(actor.accountId);
    const fallback = profile?.defaultNoticeText?.trim();
    const defaultText = fallback || list[0]?.text || '';
    const rest = list.filter((t) => t.text !== defaultText);
    return defaultText ? [{ id: null, text: defaultText, isDefault: true }, ...rest] : rest;
  }
}
