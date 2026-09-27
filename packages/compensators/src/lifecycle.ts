/**
 * THE COMPENSATION LIFECYCLE — docs/module6.md §5.2, §5.3, §5.8, as data and pure functions.
 *
 *   captured (armed, forward pending) ─ forward call ─┬─ committed ─▶ armed, TTL running
 *                                                     ├─ unknown   ─▶ armed (a human decides)
 *                                                     └─ failed    ─▶ not_needed
 *   armed ─ undo ─▶ executing ─┬─▶ succeeded
 *                              └─▶ armed (retry, bounded) ─▶ … ─▶ failed  ← INCIDENT
 *   armed ─ TTL passes ─▶ expired (the action is now permanent, and the UI says so)
 *
 * Everything here is deterministic: the durable workflows replay it.
 */

export type CompensationState = 'armed' | 'executing' | 'succeeded' | 'failed' | 'expired' | 'not_needed';
export type ForwardState = 'pending' | 'committed' | 'failed' | 'unknown';

const MOVES: Record<CompensationState, readonly CompensationState[]> = {
  armed: ['executing', 'expired', 'not_needed'],
  // Back to armed between bounded retries; a success or the final failure ends it.
  executing: ['armed', 'succeeded', 'failed', 'not_needed'],
  // A failed compensation can be retried by a person once the cause is fixed (a reconnected
  // connector): failed → executing. Nothing leaves succeeded/expired/not_needed.
  failed: ['executing'],
  succeeded: [],
  expired: [],
  not_needed: [],
};

export function canMove(from: CompensationState, to: CompensationState): boolean {
  return MOVES[from].includes(to);
}

/** Can this compensation run now? The reason is shown to the user when it cannot. */
export function undoable(c: { state: CompensationState; forwardState: ForwardState; ttlAt: Date | null }, now: number): { ok: true } | { ok: false; reason: string } {
  if (c.forwardState === 'pending') return { ok: false, reason: 'the action has not happened yet' };
  if (c.forwardState === 'failed') return { ok: false, reason: 'the action did not happen, so there is nothing to undo' };
  if (c.state === 'succeeded') return { ok: false, reason: 'it has already been undone' };
  if (c.state === 'not_needed') return { ok: false, reason: 'there was nothing to undo' };
  if (c.state === 'executing') return { ok: false, reason: 'it is being undone right now' };
  if (c.state === 'expired' || (c.ttlAt && c.ttlAt.getTime() <= now)) return { ok: false, reason: 'the undo window has passed; the action is now permanent' };
  return { ok: true };
}

/** After this the provider no longer keeps what the undo needs (§5.3). */
export function ttlAt(committedAt: Date, ttlMs: number): Date {
  return new Date(committedAt.getTime() + ttlMs);
}

/** "Available for another 89 days" — the honest countdown on an Undo control (§6.3). */
export function remainingText(ttl: Date | null, now: number): string | null {
  if (!ttl) return null;
  const ms = ttl.getTime() - now;
  if (ms <= 0) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * Strict reverse order of commitment (§5.8): the last action committed is the first undone.
 * `commitSeq` is global and monotonic, so program versions and `map` fan-outs interleave
 * correctly; an unknown-outcome action (no commit_seq) sorts as the most recent.
 */
export function sagaOrder<T extends { commitSeq: number | null; createdAt: Date }>(rows: readonly T[]): T[] {
  const rank = (r: T) => r.commitSeq ?? Number.MAX_SAFE_INTEGER;
  return [...rows].sort((a, b) => rank(b) - rank(a) || b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * Bounded retries with backoff (§5.8 "never retry forever"): the attempt that fails after the
 * last delay makes the compensation `failed` and opens an incident. Error codes that prove a
 * retry cannot help (permissions, a missing record, an expired credential) fail at once — with
 * the remediation that CAN help written into the incident.
 */
export const COMPENSATION_RETRY = { maxAttempts: 3, delaysMs: [2_000, 8_000] } as const;

const PERMANENT = new Set(['PERMISSION_DENIED', 'NOT_FOUND', 'VALIDATION', 'CONFLICT', 'AUTH_EXPIRED', 'CONNECTOR_UNAVAILABLE', 'EGRESS_DENIED']);

export function retryable(code: string): boolean {
  return !PERMANENT.has(code);
}

export function nextDelay(attempt: number): number | null {
  if (attempt >= COMPENSATION_RETRY.maxAttempts) return null;
  return COMPENSATION_RETRY.delaysMs[attempt - 1] ?? COMPENSATION_RETRY.delaysMs.at(-1)!;
}
