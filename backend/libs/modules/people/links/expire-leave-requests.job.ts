import { Injectable, Logger } from '@nestjs/common';
import { LeaveRequestUseCase } from './leave-request.use-case.js';

/** UC-40: leave requests without an answer for 7 days expire (5.8.2 3б); runs from the worker every few minutes. */
@Injectable()
export class ExpireLeaveRequestsJob {
  private readonly logger = new Logger(ExpireLeaveRequestsJob.name);

  constructor(private readonly leaves: LeaveRequestUseCase) {}

  async run(): Promise<number> {
    const count = await this.leaves.expireOverdue();
    if (count > 0) this.logger.log({ count }, 'leave requests expired');
    return count;
  }
}
