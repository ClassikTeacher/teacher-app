import { Inject, Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { ENV, type Env } from '@shared/config/index.js';
import { InvitationService } from '@modules/identity/invitation.service.js';
import type { TelegramIdentity } from '@modules/identity/redeem-staff-invitation.use-case.js';
import type { InvitationKind } from '@modules/identity/schema.js';
import {
  AcceptStudentInvitationUseCase,
  type StudentInvitationPreview,
} from '@modules/people/links/accept-student-invitation.use-case.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import type { CreatedBot } from '../core/bot-factory.js';
import { cb, MENU_NS } from '../core/callback.js';
import type { BotContext } from '../core/context.js';
import { fullName } from '../core/format.js';
import type { SectionModule } from '../core/sections.js';
import { escapeHtml, renderMenu } from '../core/ui.js';
import { redirectForeignInvitation } from '../person/invite-redirect.js';
import { PersonBot, type PersonBotTexts } from '../person/person-bot.js';
import { menuCb } from '../person/person-menu.js';
import { StudentOnboardingFlow } from './onboarding.flow.js';
import { STUDENT_SECTION_MODULES, STUDENT_SECTIONS, type StudentSection } from './sections.js';

/** StudentBot (4.2): accepts personal invitations (UC-10) and serves the student menu (4.4). */
@Injectable()
export class StudentBot extends PersonBot<StudentSection, StudentInvitationPreview> {
  readonly kind = 'student' as const;
  protected readonly role = 'STUDENT' as const;
  protected readonly sectionKeys = STUDENT_SECTIONS;
  protected readonly menuPrefix = 'smenu';
  protected readonly onboardingFlowName: string;
  protected readonly texts: PersonBotTexts = {
    stranger: 'student-need-invite',
    onboarding: 'student-need-invite',
    notAllowed: 'student-not-student',
    help: 'student-help',
    mainMenu: 'student-main-menu',
  };

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly invitations: InvitationService,
    private readonly accept: AcceptStudentInvitationUseCase,
    private readonly links: TeacherStudentRepository,
    private readonly onboarding: StudentOnboardingFlow,
    @Inject(STUDENT_SECTION_MODULES) sections: SectionModule<StudentSection>[],
  ) {
    super(sections);
    this.onboardingFlowName = onboarding.name;
  }

  protected registerFlows({ flows }: CreatedBot): void {
    flows.register(this.onboarding);
  }

  protected async peekKind(ctx: BotContext, token: string): Promise<InvitationKind | null> {
    return (await this.invitations.peek(token, ctx.from!.id, new Date()))?.kind ?? null;
  }

  protected redirect(ctx: BotContext, kind: InvitationKind): Promise<boolean> {
    return redirectForeignInvitation(ctx, this.env, this.kind, kind);
  }

  protected peek(ctx: BotContext, token: string): Promise<StudentInvitationPreview | null> {
    return this.accept.peek(token, ctx.from!.id);
  }

  /** UC-10 5б: already studying with this teacher. */
  protected async problemOf(ctx: BotContext, preview: StudentInvitationPreview) {
    if (!ctx.actor) return null;
    const existing = await this.links.findByPair(preview.teacher.id, ctx.actor.account.id);
    return existing?.status === 'active'
      ? { key: 'student-already-linked', vars: { teacher: escapeHtml(fullName(preview.teacher)) } }
      : null;
  }

  /** The invitation card: who invites, which subject, Accept / Decline (UC-10 step 5). */
  protected async renderCard(
    ctx: BotContext,
    preview: StudentInvitationPreview,
    token: string,
  ): Promise<void> {
    const kb = new InlineKeyboard()
      .text(ctx.t('btn-accept-invite'), cb(MENU_NS, 'inv', 'accept', token))
      .text(ctx.t('btn-decline-invite'), cb(MENU_NS, 'inv', 'decline', token));
    await renderMenu(
      ctx,
      ctx.t('student-invite-card', {
        teacher: escapeHtml(fullName(preview.teacher)),
        subjects: escapeHtml(preview.subjects.map((s) => s.name).join(', ') || '—'),
      }),
      kb,
    );
  }

  /** An existing account (another teacher's student, a parent, even a teacher) joins without a second questionnaire. */
  protected async acceptExisting(
    ctx: BotContext,
    user: TelegramIdentity,
    token: string,
    chatId: number,
  ): Promise<void> {
    const result = await this.accept.accept({ user, token, chatId });
    await renderMenu(
      ctx,
      ctx.t('sonb-done', { teacher: escapeHtml(fullName(result.teacher)) }),
      new InlineKeyboard().text(ctx.t('btn-open-menu'), menuCb('main')),
    );
  }

  protected startOnboarding(
    ctx: BotContext,
    preview: StudentInvitationPreview,
    token: string,
  ): Promise<void> {
    return this.onboarding.start(ctx, {
      token,
      teacherName: fullName(preview.teacher),
      grade: preview.link.inviteGrade ?? '',
    });
  }

  protected async decline(ctx: BotContext, user: TelegramIdentity, token: string): Promise<void> {
    await this.accept.decline(user, token);
    await renderMenu(ctx, ctx.t('student-invite-declined'));
  }
}
