import { Injectable, Logger } from '@nestjs/common';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { Clock, HOUR_MS } from '@shared/time/clock.js';
import { OutboxService } from '@modules/outbox/outbox.service.js';
import { FileRepository } from './file.repository.js';
import { FileStorage, isMissingObject } from './file-storage.js';
import type { FileRow } from './schema.js';
import { VirusScanner } from './virus-scanner.js';

/** HW-06 💡: an unfinished submission (and its files) lives 24 hours. */
export const DRAFT_TTL_MS = 24 * HOUR_MS;
const BATCH = 100;

/**
 * Two sweeps: (1) draft files nobody attached within 24 h are deleted from S3 and the teacher's quota is
 * released; (2) files whose antivirus check was deferred (scanner down, 10.4) are scanned again; an infected
 * one is quarantined (`file.infected`) so the owner's content can react. Every item is independent: one
 * failure is logged and the next tick retries it.
 */
@Injectable()
export class FileMaintenanceJob {
  private readonly logger = new Logger(FileMaintenanceJob.name);

  constructor(
    private readonly txm: TransactionManager,
    private readonly files: FileRepository,
    private readonly storage: FileStorage,
    private readonly scanner: VirusScanner,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  async run(): Promise<{ purged: number; scanned: number }> {
    const purged = await this.purgeDrafts();
    const scanned = await this.rescan();
    if (purged + scanned > 0) this.logger.debug({ purged, scanned }, 'file maintenance');
    return { purged, scanned };
  }

  async purgeDrafts(): Promise<number> {
    const before = new Date(this.clock.now().getTime() - DRAFT_TTL_MS);
    let purged = 0;
    for (const f of await this.files.listDraftsOlderThan(before, BATCH)) {
      try {
        if (await this.removeDraft(f.id)) purged += 1;
      } catch (error) {
        this.logger.warn({ err: error, fileId: f.id }, 'draft purge failed; will retry');
      }
    }
    return purged;
  }

  /**
   * Deletes a draft for good. The row is locked and re-checked inside the transaction, so a concurrent
   * `markAttached` either wins (nothing is deleted) or waits and then attaches zero rows (its caller sees that).
   * The S3 delete happens under the lock: if it fails, nothing is committed and the next tick retries.
   */
  async removeDraft(fileId: string): Promise<boolean> {
    return this.txm.run(async () => {
      const f = await this.files.lockById(fileId);
      if (!f || f.status !== 'draft') return false;
      await this.deleteObject(f);
      await this.files.update(f.id, { status: 'deleted', deletedAt: this.clock.now() });
      await this.files.release(f.ownerTeacherId, f.size);
      return true;
    });
  }

  /** Deletes any file (used by the owner's content when it removes something); same locking as drafts. */
  async remove(fileId: string): Promise<boolean> {
    return this.txm.run(async () => {
      const f = await this.files.lockById(fileId);
      if (!f || f.status === 'deleted') return false;
      await this.deleteObject(f);
      await this.files.update(f.id, { status: 'deleted', deletedAt: this.clock.now() });
      await this.files.release(f.ownerTeacherId, f.size);
      return true;
    });
  }

  private async deleteObject(f: FileRow): Promise<void> {
    try {
      await this.storage.delete(f.key);
    } catch (error) {
      if (!isMissingObject(error)) throw error; // an already missing object is fine
    }
  }

  async rescan(): Promise<number> {
    let scanned = 0;
    for (const f of await this.files.listPendingScan(BATCH)) {
      if (!this.scanner.enabled) {
        await this.files.setScan(f.id, 'skipped');
        scanned += 1;
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = await this.storage.getBytes(f.key);
      } catch (error) {
        if (isMissingObject(error)) {
          this.logger.error(
            { fileId: f.id, key: f.key },
            'object missing for a pending file; dropping the row',
          );
          await this.remove(f.id);
        } else {
          this.logger.warn({ err: error, fileId: f.id }, 'cannot read a pending file; will retry');
        }
        continue;
      }
      const { result, detail } = await this.scanner.scan(bytes);
      if (result === 'unavailable') break; // still down: try again on the next tick
      await this.txm.run(async () => {
        await this.files.setScan(f.id, result, detail);
        if (result === 'infected')
          await this.outbox.publish({
            type: 'file.infected',
            aggregateType: 'file',
            aggregateId: f.id,
            payload: { fileId: f.id, uploadedBy: f.uploadedBy, ownerTeacherId: f.ownerTeacherId },
          });
      });
      scanned += 1;
    }
    return scanned;
  }
}
