import { Injectable, Logger } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { Clock } from '@shared/time/clock.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { AssignmentRepository } from './assignment.repository.js';

const BATCH = 200;

/**
 * UC-40 (5.10.2 `assigned → overdue`): targets whose due date passed without a submission are marked overdue
 * and the student is told (`homework.overdue`, once per target). Rows are locked with SKIP LOCKED, so several
 * workers never fight over the same batch.
 */
@Injectable()
export class OverdueAssignmentsJob {
  private readonly logger = new Logger(OverdueAssignmentsJob.name);

  constructor(
    private readonly txm: TransactionManager,
    private readonly repo: AssignmentRepository,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  async run(): Promise<number> {
    let total = 0;
    for (;;) {
      const done = await this.txm.run(async () => {
        const now = this.clock.now();
        const targets = await this.repo.lockOverdue(now, BATCH);
        const assignments = new Map(
          (await this.repo.findByIds([...new Set(targets.map((t) => t.assignmentId))])).map((a) => [a.id, a]),
        );
        for (const t of targets) {
          const assignment = assignments.get(t.assignmentId);
          await this.repo.updateTarget(t.id, { status: 'overdue', overdueNotifiedAt: now });
          if (!assignment) continue;
          await this.outbox.publish({
            type: 'homework.overdue',
            aggregateType: 'assignment',
            aggregateId: t.assignmentId,
            payload: {
              assignmentId: t.assignmentId,
              teacherId: assignment.teacherId,
              targetId: t.id,
              studentId: t.studentId,
            },
          });
        }
        return targets.length;
      });
      total += done;
      if (done < BATCH) break;
    }
    if (total > 0) this.logger.debug({ total }, 'assignments marked overdue');
    return total;
  }
}
