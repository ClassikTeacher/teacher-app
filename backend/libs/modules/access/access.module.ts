import { Module } from '@nestjs/common';
import { RedisModule } from '@shared/redis/redis.module.js';
import { Clock } from '@shared/time/clock.js';
import { AuditModule } from '@modules/audit/audit.module.js';
import { IdentityModule } from '@modules/identity/identity.module.js';
import { OutboxModule } from '@modules/outbox/outbox.module.js';
import { FeatureAdminUseCase } from './features/feature-admin.use-case.js';
import { FeatureRepository } from './features/feature.repository.js';
import { FeatureService } from './features/feature.service.js';
import { AuthTokenService } from './http/auth-token.service.js';
import { BearerAuthGuard } from './http/bearer-auth.guard.js';
import { SystemKeyGuard } from './http/system-key.guard.js';

const PROVIDERS = [
  Clock,
  AuthTokenService,
  BearerAuthGuard,
  SystemKeyGuard,
  FeatureRepository,
  FeatureService,
  FeatureAdminUseCase,
];

@Module({
  imports: [RedisModule, IdentityModule, AuditModule, OutboxModule],
  providers: PROVIDERS,
  // IdentityModule is re-exported so controllers guarded by BearerAuthGuard resolve ActorResolver.
  exports: [...PROVIDERS, IdentityModule],
})
export class AccessModule {}
