import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '@shared/config/index.js';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock, DAY_MS } from '@shared/time/clock.js';
import { type Actor, assertActive, primaryRole } from '@modules/access/actor.js';
import { FeatureService } from '@modules/access/features/feature.service.js';
import { AuditService } from '@modules/audit/audit.service.js';
import { AccountRepository } from '@modules/identity/account.repository.js';
import type { AccountRow } from '@modules/identity/schema.js';
import { FamilyLinkRepository } from '@modules/people/family/family-link.repository.js';
import { LessonsQuery } from '@modules/schedule/lessons/lessons.query.js';
import {
  type PersonLessonView,
  PersonScheduleQuery,
} from '@modules/schedule/lessons/person-schedule.query.js';
import type { LessonFormat, LessonStatus } from '@modules/schedule/schema.js';
import { IcsFeedRepository } from './ics-feed.repository.js';
import { buildIcs, type IcsEvent } from './ics.builder.js';

/** The feed covers a month back and three months ahead (5.14.2: «только свои занятия»). */
export const ICS_PAST_DAYS = 30;
export const ICS_AHEAD_DAYS = 90;
export const ICS_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LIVE: readonly LessonStatus[] = ['scheduled', 'awaiting_report', 'completed'];
const FORMAT_LABEL: Record<LessonFormat, string> = {
  online: 'Онлайн',
  in_person: 'Очно',
  at_student: 'У ученика',
};

export function hashIcsToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 5.14.2: a secret read-only calendar link per account (teacher, student, parent). The teacher's own link needs
 * the `calendar.ics` feature; a student's or a parent's feed lists only lessons of teachers who have it (5.3.3:
 * the students' abilities follow the teacher's features). Only the hash of the token is stored (as with
 * invitations, INV-05), so a link is shown once: asking for a link re-issues it and the previous one stops
 * working — that is the «перевыпуск» of the spec.
 */
@Injectable()
export class IcsUseCase {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly txm: TransactionManager,
    private readonly feeds: IcsFeedRepository,
    private readonly accounts: AccountRepository,
    private readonly family: FamilyLinkRepository,
    private readonly lessons: LessonsQuery,
    private readonly personSchedule: PersonScheduleQuery,
    private readonly features: FeatureService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** Whether the account currently holds a live link (the screens say so without revealing it). */
  async hasLink(actor: Actor): Promise<boolean> {
    return (await this.feeds.findLive(actor.accountId)) !== null;
  }

  /** `POST /ics/rotate` and the «Получить / перевыпустить ссылку» button: the old link stops working at once. */
  async rotate(actor: Actor): Promise<string> {
    assertActive(actor);
    if (actor.roles.includes('TEACHER')) await this.features.assertEnabled(actor.accountId, 'calendar.ics');
    else if (!actor.roles.includes('STUDENT') && !actor.roles.includes('PARENT'))
      throw AppError.forbidden('No calendar for this role');
    const now = this.clock.now();
    return this.txm.run(async () => {
      const existing = await this.feeds.findLive(actor.accountId, { forUpdate: true });
      if (existing) await this.feeds.revoke(existing.id, now);
      const token = randomBytes(32).toString('base64url');
      const row = await this.feeds.insert(actor.accountId, hashIcsToken(token));
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: primaryRole(actor),
        action: existing ? 'ics.rotated' : 'ics.issued',
        entityType: 'ics_feed',
        entityId: row.id,
        source: actor.source,
        ip: actor.ip,
      });
      return this.url(token);
    });
  }

  /** The calendar text for a token, or NOT_FOUND (a revoked or unknown token says nothing more). */
  async feed(token: string): Promise<string> {
    if (!ICS_TOKEN.test(token)) throw AppError.notFound('feed');
    const row = await this.feeds.findByTokenHash(hashIcsToken(token));
    if (!row) throw AppError.notFound('feed');
    const account = await this.accounts.findById(row.accountId);
    if (!account || account.status !== 'active') throw AppError.notFound('feed');
    const roles = await this.accounts.activeRoles(account.id);
    const actor: Actor = { accountId: account.id, roles, status: account.status, source: 'api' };
    const now = this.clock.now();
    const range = {
      start: new Date(now.getTime() - ICS_PAST_DAYS * DAY_MS),
      end: new Date(now.getTime() + ICS_AHEAD_DAYS * DAY_MS),
    };
    const events: IcsEvent[] = [];
    if (roles.includes('TEACHER') && (await this.features.isEnabled(account.id, 'calendar.ics'))) {
      for (const v of await this.lessons.teacherLessons(account.id, range, LIVE)) {
        const who = v.group ? v.group.name : v.participants.map((p) => p.displayName).join(', ');
        events.push(this.event(v.lesson, `${v.subject?.name ?? 'Занятие'} — ${who}`));
      }
    }
    if (roles.includes('STUDENT'))
      events.push(...(await this.personEvents(await this.personSchedule.forStudent(actor, range), null)));
    if (roles.includes('PARENT')) {
      for (const link of await this.family.listActiveByParent(account.id)) {
        const child = await this.accounts.findById(link.studentId);
        if (!child || child.status === 'blocked') continue;
        const views = await this.personSchedule.forChild(actor, child.id, range);
        events.push(...(await this.personEvents(views, child)));
      }
    }
    events.sort((a, b) => a.start.getTime() - b.start.getTime());
    return buildIcs('Занятия', events, now);
  }

  // --- internals ----------------------------------------------------------------------------------

  private async personEvents(views: PersonLessonView[], child: AccountRow | null): Promise<IcsEvent[]> {
    const out: IcsEvent[] = [];
    const allowed = new Map<string, boolean>();
    for (const v of views) {
      if (v.lesson.status === 'cancelled') continue;
      let ok = allowed.get(v.teacher.id);
      if (ok === undefined) {
        ok = await this.features.isEnabled(v.teacher.id, 'calendar.ics');
        allowed.set(v.teacher.id, ok);
      }
      if (!ok) continue;
      const teacher = `${v.teacher.firstName} ${v.teacher.lastName}`.trim();
      const prefix = child ? `${child.firstName}: ` : '';
      out.push(this.event(v.lesson, `${prefix}${v.subject?.name ?? 'Занятие'} — ${teacher}`));
    }
    return out;
  }

  private event(
    lesson: { id: string; startsAt: Date; endsAt: Date; version: number; format: LessonFormat | null },
    summary: string,
  ): IcsEvent {
    return {
      uid: `${lesson.id}@tutor-platform`,
      start: lesson.startsAt,
      end: lesson.endsAt,
      summary,
      description: lesson.format ? FORMAT_LABEL[lesson.format] : null,
      sequence: lesson.version,
    };
  }

  private url(token: string): string {
    return `${this.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/v1/ics/${token}.ics`;
  }
}
