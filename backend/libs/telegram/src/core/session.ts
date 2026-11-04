import { RedisAdapter } from '@grammyjs/storage-redis';
import { type MiddlewareFn, session, type StorageAdapter } from 'grammy';
import type { Redis } from 'ioredis';
import type { BotKind } from '@shared/config/env.schema.js';
import type { BotContext, SessionData } from './context.js';

/** Dialog state lives this long without activity; afterwards the user is asked to start over (7.5). */
export const SESSION_TTL_SECONDS = 60 * 60;

const sessionKey = (bot: BotKind) => (ctx: Pick<BotContext, 'chat'>) =>
  ctx.chat?.id === undefined ? undefined : `tg:${bot}:${ctx.chat.id}`;

/** Skips the write when the session did not change (grammY writes after every update otherwise). */
function skipUnchangedWrites<T>(inner: StorageAdapter<T>): StorageAdapter<T> {
  const snapshots = new Map<string, string>();
  return {
    read: async (key) => {
      const value = await inner.read(key);
      snapshots.set(key, JSON.stringify(value ?? null));
      return value;
    },
    write: async (key, value) => {
      const serialized = JSON.stringify(value);
      if (snapshots.get(key) === serialized) return;
      snapshots.delete(key);
      await inner.write(key, value);
    },
    delete: async (key) => {
      snapshots.delete(key);
      await inner.delete(key);
    },
  };
}

export function createSessionMiddleware(redis: Redis, bot: BotKind): MiddlewareFn<BotContext> {
  return session<SessionData, BotContext>({
    initial: () => ({}),
    getSessionKey: sessionKey(bot),
    storage: skipUnchangedWrites(
      new RedisAdapter<SessionData>({ instance: redis, ttl: SESSION_TTL_SECONDS }),
    ),
  });
}

/** In-memory storage for tests and local experiments. */
export function createMemorySessionMiddleware(bot: BotKind): MiddlewareFn<BotContext> {
  const store = new Map<string, SessionData>();
  return session<SessionData, BotContext>({
    initial: () => ({}),
    getSessionKey: sessionKey(bot),
    storage: skipUnchangedWrites({
      read: (key) => store.get(key),
      write: (key, value) => {
        store.set(key, structuredClone(value));
      },
      delete: (key) => {
        store.delete(key);
      },
    }),
  });
}
