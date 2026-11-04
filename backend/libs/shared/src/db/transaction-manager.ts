import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DB, type Db, type DbClient, type Tx } from './drizzle.js';

type Hook = () => Promise<void> | void;

interface TxContext {
  tx: Tx;
  afterCommit: Hook[];
  closed: boolean;
}

/** `tx` is assigned as soon as drizzle opens the (sub)transaction, before any user code runs. */
function newContext(): TxContext {
  return { tx: undefined as unknown as Tx, afterCommit: [], closed: false };
}

/**
 * Binds a database transaction to the current async context (AsyncLocalStorage).
 * Repositories read `txm.db` and transparently take part in the use-case transaction.
 *
 * Semantics:
 * - `run` starts a transaction, or joins the active one (no savepoint: a caught inner failure
 *   leaves the outer transaction aborted, so use `runSavepoint` when you intend to swallow errors);
 * - `afterCommit` hooks fire after the outermost commit; hook failures are logged, never rethrown,
 *   and never affect the already committed data — use the outbox for anything that must be reliable;
 * - using `db` after the context completed throws instead of touching a finished transaction.
 */
@Injectable()
export class TransactionManager {
  private readonly logger = new Logger(TransactionManager.name);
  private readonly storage = new AsyncLocalStorage<TxContext>();

  constructor(@Inject(DB) private readonly root: Db) {}

  /** The current transaction if one is active, otherwise the root database. */
  get db(): DbClient {
    const store = this.storage.getStore();
    if (!store) return this.root;
    if (store.closed) {
      throw new Error('Transaction context already completed; do not use txm.db after run() resolved');
    }
    return store.tx;
  }

  get inTransaction(): boolean {
    return this.storage.getStore() !== undefined;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.storage.getStore()) return fn();
    const context = newContext();
    let result: T;
    try {
      result = await this.root.transaction(async (tx) => {
        context.tx = tx;
        return this.storage.run(context, fn);
      });
    } finally {
      context.closed = true;
    }
    await this.fireHooks(context.afterCommit);
    return result;
  }

  /**
   * Runs `fn` in a savepoint of the active transaction so that its failure can be caught by the caller
   * without aborting the outer transaction. Hooks registered inside are kept only if the savepoint succeeds.
   * Outside a transaction this behaves like `run`.
   */
  async runSavepoint<T>(fn: () => Promise<T>): Promise<T> {
    const parent = this.storage.getStore();
    if (!parent) return this.run(fn);
    const inner = newContext();
    try {
      const result = await parent.tx.transaction(async (sp) => {
        inner.tx = sp;
        return this.storage.run(inner, fn);
      });
      parent.afterCommit.push(...inner.afterCommit);
      return result;
    } finally {
      inner.closed = true;
    }
  }

  /**
   * Registers a side effect that must only happen after the outermost transaction commits
   * (cache invalidation, queue pushes). Outside a transaction the hook runs immediately.
   */
  async afterCommit(hook: Hook): Promise<void> {
    const store = this.storage.getStore();
    if (store) {
      store.afterCommit.push(hook);
      return;
    }
    await this.fireHooks([hook]);
  }

  private async fireHooks(hooks: Hook[]): Promise<void> {
    for (const hook of hooks) {
      try {
        await hook();
      } catch (error) {
        this.logger.error({ err: error }, 'afterCommit hook failed; data is already committed');
      }
    }
  }
}
