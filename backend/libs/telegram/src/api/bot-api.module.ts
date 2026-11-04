import { autoRetry } from '@grammyjs/auto-retry';
import { Global, Inject, Module } from '@nestjs/common';
import { Api } from 'grammy';
import { botConfigs, type BotKind, ENV, type Env } from '@shared/config/index.js';

export const BOT_APIS = Symbol('BOT_APIS');

/**
 * Send-only Telegram clients for processes that do not receive updates (the worker). One `Api` per token;
 * rate limiting lives in the BullMQ send queues (7.5 "Скорость отправки"), retries on 429 in autoRetry.
 */
export class BotApiRegistry {
  private readonly apis = new Map<BotKind, Api>();

  constructor(env: Env) {
    for (const config of Object.values(botConfigs(env))) {
      if (!config.token) continue;
      const api = new Api(config.token);
      api.config.use(autoRetry({ maxRetryAttempts: 2, maxDelaySeconds: 10 }));
      this.apis.set(config.kind, api);
    }
  }

  get(kind: BotKind): Api | undefined {
    return this.apis.get(kind);
  }

  /** Tests swap the client of a bot for a fake. */
  set(kind: BotKind, api: Api): void {
    this.apis.set(kind, api);
  }
}

@Global()
@Module({
  providers: [{ provide: BOT_APIS, inject: [ENV], useFactory: (env: Env) => new BotApiRegistry(env) }],
  exports: [BOT_APIS],
})
export class BotApiModule {
  constructor(@Inject(BOT_APIS) _registry: BotApiRegistry) {}
}
