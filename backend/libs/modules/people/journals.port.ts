import { Injectable, Logger } from '@nestjs/common';

export interface JournalLinkContext {
  linkId: string;
  teacherId: string;
  studentId: string;
  subjectIds: readonly string[];
}

export interface JournalsProvisioner {
  ensureForLink(context: JournalLinkContext): Promise<void>;
}

/**
 * Port for the gradebook (JRN-01…02): three journals per subject of a link are created when the link
 * becomes active or gains a subject. The `gradebook` module binds the real implementation at start-up
 * (M6-01); the call runs inside the caller's transaction (T-10), so journals appear together with the link.
 * Without a binding (people-only test contexts) the port only logs.
 */
@Injectable()
export class JournalsPort implements JournalsProvisioner {
  private readonly logger = new Logger(JournalsPort.name);
  private impl: JournalsProvisioner | null = null;

  bind(impl: JournalsProvisioner): void {
    this.impl = impl;
  }

  async ensureForLink(context: JournalLinkContext): Promise<void> {
    if (this.impl) return this.impl.ensureForLink(context);
    this.logger.debug(
      { linkId: context.linkId, subjects: context.subjectIds.length },
      'journals port unbound',
    );
  }
}
