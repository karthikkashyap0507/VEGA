import type { Reversibility } from '@vega/contracts';
import { ToolError } from './errors.js';

/**
 * Retry with exponential backoff and full jitter (module2.md §5.3).
 *
 * THE RULE: an R2/R3 action is never retried once it may have committed. A timeout or a 5xx
 * on `gmail.send` does not tell us the message was not sent, and sending twice is exactly the
 * customer-visible failure this product exists to prevent. Such actions retry only on errors
 * that PROVE nothing happened: a rate-limit or auth rejection.
 *
 * R0/R1 actions are either read-only or idempotent-with-compensator, so transient failures
 * retry normally.
 */
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 200, maxDelayMs: 10_000 };

export function isRetryable(error: unknown, reversibility: Reversibility): boolean {
  if (!(error instanceof ToolError)) return false;
  const code = error.code;
  const retryableCode = code === 'RATE_LIMITED' || code === 'TRANSIENT';
  if (!retryableCode) return false;
  if (reversibility === 'R2' || reversibility === 'R3') return error.committed === 'no';
  return true;
}

export function delayFor(attempt: number, policy: RetryPolicy, error?: unknown): number {
  const hinted = error instanceof ToolError ? error.retryAfterSeconds : undefined;
  if (hinted !== undefined) return Math.min(hinted * 1000, policy.maxDelayMs);
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor((policy.random ?? Math.random)() * ceiling);
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  reversibility: Reversibility,
  policy: RetryPolicy = DEFAULT_RETRY,
): Promise<T> {
  const sleep = policy.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === policy.maxAttempts || !isRetryable(error, reversibility)) throw error;
      await sleep(delayFor(attempt, policy, error));
    }
  }
  throw lastError;
}
