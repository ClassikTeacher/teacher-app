import { Injectable, Logger } from '@nestjs/common';

export interface JournalLinkContext {
  linkId: string;
  teacherId: string;
  studentId: string;
  subjectIds: readonly string[];
}

/**
 * Port for the gradebook (JRN-01…02): three journals per subject of a link are created when the link
 * becomes active or gains a subject. The real implementation arrives with M6-01; until then this stub
 * only logs, so people use-cases already call it at the right moments.
 */
@Injectable()
export class JournalsPort {
  private readonly logger = new Logger(JournalsPort.name);

  async ensureForLink(context: JournalLinkContext): Promise<void> {
    this.logger.debug(
      { linkId: context.linkId, subjects: context.subjectIds.length },
      'journals provisioning deferred to M6-01',
    );
  }
}
