import { TERMINAL_RUN_STATUSES, type RunStatus } from '@vega/contracts';

/**
 * The run state machine — docs/module4.md §5.4, as data. Every status change goes through
 * `RunStore.setStatus`, which refuses a transition not listed here: a run cannot jump from
 * AWAITING_APPROVAL to COMPLETED without executing, and nothing leaves a terminal state.
 *
 *   CREATED → PLANNING → PLANNED → EXECUTING ─┬─▶ COMPLETED
 *                                             ├─▶ AWAITING_APPROVAL ─(signal)─▶ EXECUTING
 *                                             ├─▶ HELD ─(release/revoke)─▶ EXECUTING / CANCELLED
 *                                             ├─▶ AWAITING_INPUT ─(signal)─▶ PLANNING / REPLANNING / EXECUTING
 *                                             ├─▶ REPLANNING ─▶ PLANNED (next version)
 *                                             ├─▶ COMPENSATING ─▶ COMPENSATED | COMPENSATION_FAILED
 *                                                 (M6: from any live state that is about to FAIL
 *                                                 with committed actions it can still undo)
 *                                             ├─▶ NEEDS_ATTENTION (an outcome nobody can know)
 *                                             └─▶ CANCELLED | FAILED
 *
 * REPLANNING and NEEDS_ATTENTION are this implementation's names for two states the diagram
 * implies: "C2 replans from checkpoint" and the §8.4 UNKNOWN escalation.
 */
const T: Record<RunStatus, readonly RunStatus[]> = {
  CREATED: ['PLANNING', 'AWAITING_INPUT', 'FAILED', 'CANCELLED'],
  PLANNING: ['PLANNED', 'PLAN_REJECTED', 'AWAITING_INPUT', 'FAILED', 'CANCELLED'],
  PLANNED: ['EXECUTING', 'FAILED', 'CANCELLED'],
  EXECUTING: ['COMPLETED', 'AWAITING_APPROVAL', 'AWAITING_INPUT', 'HELD', 'REPLANNING', 'COMPENSATING', 'NEEDS_ATTENTION', 'FAILED', 'CANCELLED'],
  AWAITING_APPROVAL: ['EXECUTING', 'COMPENSATING', 'FAILED', 'CANCELLED'],
  // → EXECUTING: resumed after a connector was re-authorized (nothing to replan).
  AWAITING_INPUT: ['PLANNING', 'REPLANNING', 'EXECUTING', 'COMPENSATING', 'FAILED', 'CANCELLED'],
  HELD: ['EXECUTING', 'COMPENSATING', 'FAILED', 'CANCELLED', 'NEEDS_ATTENTION'],
  // → AWAITING_INPUT: the new plan needs a human to resolve an ambiguity first.
  REPLANNING: ['PLANNED', 'PLAN_REJECTED', 'AWAITING_INPUT', 'COMPENSATING', 'FAILED', 'CANCELLED'],
  COMPENSATING: ['COMPENSATED', 'COMPENSATION_FAILED'],
  NEEDS_ATTENTION: ['EXECUTING', 'COMPLETED', 'COMPENSATING', 'FAILED', 'CANCELLED'],
  PLAN_REJECTED: [],
  COMPENSATED: [],
  COMPENSATION_FAILED: [],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return from === to ? !TERMINAL_RUN_STATUSES.has(from) : T[from].includes(to);
}

export function nextStatuses(from: RunStatus): readonly RunStatus[] {
  return T[from];
}

export class TransitionError extends Error {
  constructor(
    readonly from: RunStatus,
    readonly to: RunStatus,
  ) {
    super(`run cannot go from ${from} to ${to}`);
    this.name = 'TransitionError';
  }
}

/**
 * Webhook event kinds (docs/module4.md §7) a transition emits, in addition to `run.status`.
 * Delivery reads these from platform_events (the outbox).
 */
export function webhookKinds(from: RunStatus, to: RunStatus, programVersion: number): string[] {
  const kinds: string[] = [];
  if (to === 'EXECUTING' && (from === 'PLANNED' && programVersion <= 1)) kinds.push('run.started');
  if (to === 'COMPLETED') kinds.push('run.completed');
  if (to === 'FAILED' || to === 'PLAN_REJECTED' || to === 'COMPENSATION_FAILED') kinds.push('run.failed');
  if (to === 'AWAITING_INPUT') kinds.push('run.awaiting_input');
  if (to === 'PLANNED' && from === 'REPLANNING') kinds.push('run.replanned');
  if (to === 'NEEDS_ATTENTION') kinds.push('run.needs_attention');
  return kinds;
}
