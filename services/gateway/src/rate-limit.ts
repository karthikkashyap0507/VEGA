import type Valkey from 'iovalkey';

/**
 * Fixed-window rate limiting — module1.md §7.2 "per tenant and per token; 429 with Retry-After".
 *
 * Two independent budgets apply to every authenticated request: one for the token (a runaway
 * script on one laptop) and one for the tenant (a runaway integration across many). Either
 * exhausted is a 429. Unauthenticated routes (login, callback, signup) are limited per client
 * address instead.
 *
 * Valkey, not Redis (TECHSTACK §7.1). The in-memory store is for tests and single-process
 * development only; it does not share state across replicas.
 */

export interface RateStore {
  /** Increments `key` in a window of `windowMs`; returns the new count and ms until reset. */
  hit(key: string, windowMs: number): Promise<{ count: number; resetMs: number }>;
}

export class ValkeyRateStore implements RateStore {
  constructor(private readonly client: Valkey) {}

  async hit(key: string, windowMs: number) {
    const window = Math.floor(Date.now() / windowMs);
    const k = `rl:${key}:${window}`;
    const results = await this.client.multi().incr(k).pexpire(k, windowMs, 'NX').exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    return { count, resetMs: (window + 1) * windowMs - Date.now() };
  }
}

export class MemoryRateStore implements RateStore {
  private readonly counts = new Map<string, number>();

  async hit(key: string, windowMs: number) {
    const window = Math.floor(Date.now() / windowMs);
    const k = `${key}:${window}`;
    const count = (this.counts.get(k) ?? 0) + 1;
    this.counts.set(k, count);
    if (this.counts.size > 10_000) {
      for (const existing of this.counts.keys()) if (!existing.endsWith(`:${window}`)) this.counts.delete(existing);
    }
    return { count, resetMs: (window + 1) * windowMs - Date.now() };
  }
}

export interface Budget {
  key: string;
  limit: number;
}

/** Checks every budget; returns the retry delay in seconds for the first one exhausted. */
export async function consume(store: RateStore, budgets: Budget[], windowMs = 60_000): Promise<number | undefined> {
  for (const b of budgets) {
    const { count, resetMs } = await store.hit(b.key, windowMs);
    if (count > b.limit) return Math.max(1, Math.ceil(resetMs / 1000));
  }
  return undefined;
}
