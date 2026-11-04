import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface CorrelationStore {
  correlationId: string;
  /** Free-form context (bot kind, update id, job id...) merged into every log line. */
  context: Record<string, string | number>;
}

const storage = new AsyncLocalStorage<CorrelationStore>();

/** Runs `fn` with a correlation id so every log line produced inside (API → use-case → outbox) carries it. */
export function runWithCorrelation<T>(
  fn: () => T,
  options: { correlationId?: string; context?: Record<string, string | number> } = {},
): T {
  const store: CorrelationStore = {
    correlationId: options.correlationId ?? randomUUID(),
    context: options.context ?? {},
  };
  return storage.run(store, fn);
}

export function currentCorrelation(): CorrelationStore | undefined {
  return storage.getStore();
}

/** pino `mixin` that injects correlation data into every log record. */
export function correlationMixin(): Record<string, unknown> {
  const store = storage.getStore();
  if (!store) return {};
  return { correlation_id: store.correlationId, ...store.context };
}
