import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { AppError } from '@shared/errors/app-error.js';
import { Clock, DAY_MS } from '@shared/time/clock.js';
import { type Actor, assertRole, primaryRole } from '@modules/access/actor.js';
import { AuditService } from '@modules/audit/audit.service.js';
import type { Interval, PersonalBlockRow } from '../schema.js';
import { isValidInterval } from './intervals.js';
import { OccupancyService } from './occupancy.service.js';
import { PersonalBlockRepository } from './personal-block.repository.js';

export const MAX_BLOCK_TITLE_LENGTH = 100;
/** A block longer than this is almost certainly a typo in the end time. */
export const MAX_BLOCK_DAYS = 31;

/** 5.5.2 "Личный блок «занят»" (Р-17): only the teacher's own occupancy, hard, removable by the teacher. */
@Injectable()
export class PersonalBlockUseCase {
  constructor(
    private readonly txm: TransactionManager,
    private readonly blocks: PersonalBlockRepository,
    private readonly occupancy: OccupancyService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async create(actor: Actor, input: { during: Interval; title?: string | null }): Promise<PersonalBlockRow> {
    assertRole(actor, 'TEACHER');
    if (!isValidInterval(input.during)) throw AppError.validation('Block end must be after its start');
    if (input.during.end.getTime() - input.during.start.getTime() > MAX_BLOCK_DAYS * DAY_MS)
      throw AppError.validation('Block is too long', { maxDays: MAX_BLOCK_DAYS });
    if (input.during.end.getTime() <= this.clock.now().getTime())
      throw AppError.validation('Block is entirely in the past', { reason: 'past' });
    const title = input.title?.trim() || null;
    if (title && title.length > MAX_BLOCK_TITLE_LENGTH)
      throw AppError.validation('Title is too long', { max: MAX_BLOCK_TITLE_LENGTH });
    return this.txm.run(async () => {
      const block = await this.blocks.insert({ teacherId: actor.accountId, during: input.during, title });
      // a block never has buffers: the teacher marks exactly the busy time
      await this.occupancy.reserve({
        source: { kind: 'block', blockId: block.id },
        during: input.during,
        teacher: { accountId: actor.accountId, bufferBeforeMin: 0, bufferAfterMin: 0 },
        studentIds: [],
      });
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: primaryRole(actor),
        action: 'block.created',
        entityType: 'personal_block',
        entityId: block.id,
        after: {
          startsAt: block.startsAt.toISOString(),
          endsAt: block.endsAt.toISOString(),
          hasTitle: !!title,
        },
        source: actor.source,
        ip: actor.ip,
      });
      return block;
    });
  }

  /** A block removed meanwhile is reported as CONFLICT (the bot shows "stale"), another teacher's as NOT_FOUND (8.0). */
  async remove(actor: Actor, blockId: string): Promise<PersonalBlockRow> {
    assertRole(actor, 'TEACHER');
    const now = this.clock.now();
    return this.txm.run(async () => {
      const block = await this.blocks.findById(blockId, { forUpdate: true });
      if (!block || block.teacherId !== actor.accountId) throw AppError.notFound('block', blockId);
      const removed = await this.blocks.remove(block.id, now);
      if (!removed) throw new AppError('CONFLICT', 'Block is already removed');
      await this.occupancy.releaseBlock(block.id);
      await this.audit.record({
        actorId: actor.accountId,
        actorRole: primaryRole(actor),
        action: 'block.removed',
        entityType: 'personal_block',
        entityId: block.id,
        before: { startsAt: block.startsAt.toISOString(), endsAt: block.endsAt.toISOString() },
        source: actor.source,
        ip: actor.ip,
      });
      return removed;
    });
  }

  listInRange(actor: Actor, range: Interval): Promise<PersonalBlockRow[]> {
    assertRole(actor, 'TEACHER');
    return this.blocks.listInRange(actor.accountId, range);
  }
}
