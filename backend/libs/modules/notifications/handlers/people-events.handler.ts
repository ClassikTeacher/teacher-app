import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { AccountRepository } from '@modules/identity/account.repository.js';
import { type DeliveredEvent, DomainEventBus } from '@modules/outbox/event-bus.js';
import { TeacherStudentRepository } from '@modules/people/links/teacher-student.repository.js';
import { SubjectRepository } from '@modules/people/subject.repository.js';
import { NotificationService } from '../notification.service.js';
import { NotificationRenderer } from '../render.js';
import { BUTTONS_PAYLOAD_KEY } from '../types.js';

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const linkActivated = z.object({
  linkId: z.string().uuid(),
  teacherId: z.string().uuid(),
  studentId: z.string().uuid(),
});
const linkDeclined = z.object({ linkId: z.string().uuid(), teacherId: z.string().uuid() });

function parse<T>(schema: z.ZodType<T>, event: DeliveredEvent): T {
  const result = schema.safeParse(event.payload);
  if (!result.success)
    throw new UnrecoverableError(`malformed ${event.type} payload: ${result.error.message}`);
  return result.data;
}

/**
 * People events → teacher-facing messages (UC-10 step 7 and 5а): "Петя присоединился" with the hints
 * "пригласить родителя" and "поставить занятие" as buttons, and "ученик отклонил приглашение".
 */
@Injectable()
export class PeopleEventsHandler implements OnModuleInit {
  private readonly labels = new NotificationRenderer();
  private readonly logger = new Logger(PeopleEventsHandler.name);

  constructor(
    private readonly bus: DomainEventBus,
    private readonly accounts: AccountRepository,
    private readonly links: TeacherStudentRepository,
    private readonly subjects: SubjectRepository,
    private readonly notifications: NotificationService,
  ) {}

  onModuleInit(): void {
    this.bus.on('link.activated', (e) => this.studentJoined(e));
    this.bus.on('link.declined', (e) => this.declined(e));
  }

  private async studentJoined(event: DeliveredEvent): Promise<void> {
    const { linkId, teacherId, studentId } = parse(linkActivated, event);
    const [student, link] = await Promise.all([
      this.accounts.findById(studentId),
      this.links.findById(linkId),
    ]);
    if (!student || !link) {
      this.logger.warn({ linkId, studentId }, 'link.activated: student or link vanished; no notification');
      return;
    }
    const subjects = await this.subjects.findByIds(link.subjectIds);
    await this.notifications.schedule({
      type: 'link.student_joined',
      recipientId: teacherId,
      payload: {
        name: esc(`${student.firstName} ${student.lastName}`.trim()),
        subjects: esc(subjects.map((s) => s.name).join(', ') || '—'),
        [BUTTONS_PAYLOAD_KEY]: [
          { text: this.labels.t('btn-invite-parent'), data: `s:students:parents:${linkId}` },
          { text: this.labels.t('btn-create-lesson'), data: `s:students:lesson:${linkId}` },
        ],
      },
      dedupeKey: `link.student_joined:${event.id}`,
    });
  }

  private async declined(event: DeliveredEvent): Promise<void> {
    const { linkId, teacherId } = parse(linkDeclined, event);
    const link = await this.links.findById(linkId);
    await this.notifications.schedule({
      type: 'link.declined',
      recipientId: teacherId,
      payload: { name: esc(link?.inviteName?.trim() || '') || '—' },
      dedupeKey: `link.declined:${event.id}`,
    });
  }
}
