/**
 * THE VERIFICATION ENGINE — docs/module9.md §5.1. Six checks on every consequential step, run in
 * ONE fixed order, cheapest first, failing fast:
 *
 *   permissions (ms) → policy (ms) → conflicts (a query) → exposure (classification)
 *     → consequence (the simulation already made) → groundedness (claims × evidence)
 *
 * The order is data (CHECK_ORDER) so a test can hold it and a refactor cannot quietly reorder it.
 * An ABORT stops the remaining checks — they are recorded as SKIPPED, never as passed. ESCALATE
 * and WARN do not stop: the approver should see everything the checks found, in one packet.
 */

export const CHECK_ORDER = ['permissions', 'policy', 'conflicts', 'exposure', 'consequence', 'groundedness'] as const;
export type CheckName = (typeof CHECK_ORDER)[number];

/**
 *   PASS        nothing found
 *   WARN        found something a person should see; not a reason to stop
 *   ESCALATE    a person must decide (re-routed to approval, M8)
 *   ABORT       pre-commit: do not do it (the step stops; the run replans)
 *   COMPENSATE  post-commit: it should not have happened (the run's saga undoes it, M6)
 *   SKIPPED     not run: an earlier check aborted, or the check does not apply
 */
export type CheckOutcome = 'PASS' | 'WARN' | 'ESCALATE' | 'ABORT' | 'COMPENSATE' | 'SKIPPED';
export type Phase = 'pre_commit' | 'post_commit';

export interface CheckResult {
  check: CheckName;
  outcome: CheckOutcome;
  /** One line a person reads in the trace ("re-evaluated after generation — tier unchanged"). */
  detail: string;
  data?: Record<string, unknown>;
  durationMs?: number;
}

export type Check = () => Promise<Omit<CheckResult, 'check' | 'durationMs'>>;

export interface Verdict {
  phase: Phase;
  outcome: Exclude<CheckOutcome, 'SKIPPED'>;
  results: CheckResult[];
  /** The first check that aborted / compensated, and why — what the run's reason says. */
  reason: string | null;
  durationMs: number;
}

const RANK: Record<Exclude<CheckOutcome, 'SKIPPED'>, number> = { PASS: 0, WARN: 1, ESCALATE: 2, ABORT: 3, COMPENSATE: 3 };
const STOPS = new Set<CheckOutcome>(['ABORT', 'COMPENSATE']);

export async function verify(phase: Phase, checks: Partial<Record<CheckName, Check>>, now: () => number = () => performance.now()): Promise<Verdict> {
  const t0 = now();
  const results: CheckResult[] = [];
  let worst: Verdict['outcome'] = 'PASS';
  let reason: string | null = null;
  let stopped = false;
  for (const name of CHECK_ORDER) {
    const run = checks[name];
    if (!run) continue;
    if (stopped) {
      results.push({ check: name, outcome: 'SKIPPED', detail: 'not run: an earlier check stopped the step' });
      continue;
    }
    const t = now();
    let r: Omit<CheckResult, 'check' | 'durationMs'>;
    try {
      r = await run();
    } catch (e) {
      // A check that cannot run has not passed. Before the commit that means stop; after it, a
      // person looks (escalate) — undoing a committed action because a checker crashed is worse.
      r = { outcome: phase === 'pre_commit' ? 'ABORT' : 'ESCALATE', detail: `the check could not run: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (phase === 'pre_commit' && r.outcome === 'COMPENSATE') r = { ...r, outcome: 'ABORT' };
    if (phase === 'post_commit' && r.outcome === 'ABORT') r = { ...r, outcome: 'COMPENSATE' };
    results.push({ check: name, ...r, durationMs: Math.round(now() - t) });
    if (r.outcome !== 'SKIPPED' && RANK[r.outcome] > RANK[worst]) worst = r.outcome;
    if (STOPS.has(r.outcome)) {
      stopped = true;
      reason = `${name}: ${r.detail}`;
    }
  }
  if (!reason && worst === 'ESCALATE') reason = results.filter((r) => r.outcome === 'ESCALATE').map((r) => `${r.check}: ${r.detail}`).join('; ');
  return { phase, outcome: worst, results, reason, durationMs: Math.round(now() - t0) };
}

/** The trace's one-liner per check (§8.3): ✓ / ⚠ / ✗ / – . */
export function symbol(o: CheckOutcome): string {
  return o === 'PASS' ? '✓' : o === 'WARN' || o === 'ESCALATE' ? '⚠' : o === 'SKIPPED' ? '–' : '✗';
}
