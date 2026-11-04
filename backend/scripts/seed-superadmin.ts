import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigModule, loadDotEnv, parseEnv } from '@shared/config/index.js';
import { DbModule } from '@shared/db/index.js';
import { IdentityModule } from '@modules/identity/identity.module.js';
import { BootstrapSuperAdminService } from '@modules/identity/bootstrap-super-admin.service.js';

@Module({ imports: [ConfigModule, DbModule, IdentityModule] })
class SeedModule {}

async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') loadDotEnv();
  const env = parseEnv(process.env);
  if (!env.BOOTSTRAP_SUPERADMIN_TELEGRAM_ID) {
    throw new Error('BOOTSTRAP_SUPERADMIN_TELEGRAM_ID is not set');
  }
  const app = await NestFactory.createApplicationContext(SeedModule, { logger: ['error', 'warn'] });
  try {
    const reissue = process.argv.includes('--reissue');
    const seed = app.get(BootstrapSuperAdminService);
    const outcome = await seed.seed(env.BOOTSTRAP_SUPERADMIN_TELEGRAM_ID, { reissue });
    switch (outcome.status) {
      case 'active':
        console.log(`super admin already active (account ${outcome.accountId}); nothing to do`);
        if (outcome.telegramUserId !== env.BOOTSTRAP_SUPERADMIN_TELEGRAM_ID) {
          console.warn('warning: BOOTSTRAP_SUPERADMIN_TELEGRAM_ID differs from the active super admin;');
          console.warn('         transfer the role via POST /system/super-admin/transfer (M1-09)');
        }
        break;
      case 'blocked':
        console.log(`super admin account ${outcome.accountId} is blocked; unblock it first`);
        break;
      case 'onboarding':
        console.log(
          `super admin ${outcome.accountId} opened the link and is completing onboarding in AuthBot`,
        );
        break;
      case 'pending':
        console.log(
          `super admin seeded earlier (account ${outcome.accountId}); the previous link is still valid until ${outcome.expiresAt.toISOString()} (use --reissue to replace it)`,
        );
        break;
      case 'issued':
        console.log(
          `super admin account ${outcome.accountId}; one-time link (valid until ${outcome.expiresAt.toISOString()}):`,
        );
        console.log(outcome.link);
        break;
    }
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
