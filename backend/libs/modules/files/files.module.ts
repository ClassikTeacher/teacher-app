import { Inject, Module } from '@nestjs/common';
import { ENV, type Env } from '@shared/config/index.js';
import { Clock } from '@shared/time/clock.js';
import { AccessModule } from '@modules/access/access.module.js';
import { AuditModule } from '@modules/audit/audit.module.js';
import { IdentityModule } from '@modules/identity/identity.module.js';
import { OutboxModule } from '@modules/outbox/outbox.module.js';
import { PeopleModule } from '@modules/people/people.module.js';
import { FileDeliveryService } from './file-delivery.service.js';
import { FileMaintenanceJob } from './file-maintenance.job.js';
import { FileRepository } from './file.repository.js';
import { FileStorage } from './file-storage.js';
import { IngestFileUseCase } from './ingest-file.use-case.js';
import { StorageWarningUseCase } from './storage-warning.use-case.js';
import { TelegramFileDownloader } from './telegram-file-downloader.js';
import { UploadRateLimit } from './upload-rate-limit.js';
import { ClamdVirusScanner, NoopVirusScanner, VirusScanner } from './virus-scanner.js';

export function createVirusScanner(env: Pick<Env, 'CLAMAV_HOST' | 'CLAMAV_PORT'>): VirusScanner {
  return env.CLAMAV_HOST
    ? new ClamdVirusScanner({ host: env.CLAMAV_HOST, port: env.CLAMAV_PORT })
    : new NoopVirusScanner();
}

const PROVIDERS = [
  Clock,
  FileRepository,
  FileStorage,
  TelegramFileDownloader,
  UploadRateLimit,
  { provide: VirusScanner, inject: [ENV], useFactory: createVirusScanner },
  IngestFileUseCase,
  FileDeliveryService,
  FileMaintenanceJob,
  StorageWarningUseCase,
];

/** 7.4 `files`: upload pipeline, S3, antivirus, per-bot `file_id` cache, quota (M5-01). */
@Module({
  imports: [IdentityModule, AccessModule, AuditModule, OutboxModule, PeopleModule],
  providers: PROVIDERS,
  exports: PROVIDERS,
})
export class FilesModule {
  constructor(@Inject(VirusScanner) _scanner: VirusScanner) {}
}
