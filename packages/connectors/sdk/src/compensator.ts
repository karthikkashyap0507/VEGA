import type { RecordAffected } from '@vega/contracts';
import type { ToolContext } from './connector.js';

/**
 * COMPENSATORS — docs/module6.md §5.2. The registered inverse of an R1 action (and of the R2
 * actions that have one after release, such as deleting a Slack message).
 *
 *   capture()     BEFORE the forward call, with the forward call's arguments: everything needed
 *                 to reverse it later without re-deriving it — the world will have changed
 *   compensate()  in reverse order of commitment on rollback, or on an explicit Undo. MUST be
 *                 idempotent: a second call finds the state already restored and does nothing
 *
 * A compensator is not a perfect inverse, and says so: `confidence` (EXACT | APPROXIMATE) and
 * `sideEffects` (SILENT | NOTIFIES_THIRD_PARTY) are shown to the user before they undo, and
 * `ttlMs` is how long the provider keeps what the undo needs (after it, the action is permanent).
 *
 * The compensator lives with its connector (it speaks the provider's API through the same
 * authenticated `ToolContext` as the tools); the lifecycle — arming, TTLs, reverse ordering,
 * retries, incidents — is packages/compensators.
 */

export type CompensationConfidence = 'EXACT' | 'APPROXIMATE';
export type CompensationSideEffects = 'SILENT' | 'NOTIFIES_THIRD_PARTY';

/** What the forward call returned, recorded by the executor right after it. */
export interface ForwardOutcome {
  providerRef?: string | undefined;
  detail: unknown;
  recordsAffected: RecordAffected[];
}

export interface CompensationToken<P = unknown, A = unknown> {
  ref: string;
  toolId: string;
  /** The forward call's arguments, as executed. */
  args: A;
  /** The pre-state `capture()` returned. */
  pre: P;
  /** The forward call's outcome; null when it is unknown (the executor stopped mid-call). */
  forward: ForwardOutcome | null;
  capturedAt: string;
}

export interface CompensationResult {
  /**
   *   restored          the compensation changed the provider's state back
   *   already_restored  nothing to do: an earlier attempt (or a person) already restored it
   *   not_needed        the forward action never took effect
   */
  outcome: 'restored' | 'already_restored' | 'not_needed';
  /** One plain sentence: what was done. */
  summary: string;
  /** Who outside the organization was told (cancellations, re-invitations). */
  notified: string[];
  /** What the undo could not take back (APPROXIMATE honesty), if anything. */
  residual?: string | undefined;
  /** Ids the compensation created (a recreated event). */
  providerRefs?: string[] | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Compensator<A = any, P = any> {
  /** Matches the forward tool's `compensatorRef`. */
  ref: string;
  toolId: string;
  confidence: CompensationConfidence;
  sideEffects: CompensationSideEffects;
  /** How long the provider keeps what the undo needs. After it, the action is permanent. */
  ttlMs: number;
  /**
   * The consequence, in one or two plain sentences, shown BEFORE the user undoes:
   * "Deletes “Kickoff” and sends a cancellation to 3 attendees. They will see that it was cancelled."
   */
  describe(token: CompensationToken<P, A>): string;
  capture(args: A, ctx: ToolContext): Promise<P>;
  compensate(token: CompensationToken<P, A>, ctx: ToolContext): Promise<CompensationResult>;
}

/**
 * An R2 action with no inverse once released (an email cannot be unsent): its only undo is the
 * hold window. The M2 contract makes every R2 tool name a compensator; this is what it names.
 */
export interface HoldOnlyCompensator {
  ref: string;
  toolId: string;
  holdOnly: true;
  /** Why there is no undo after release, for the UI. */
  explanation: string;
}

export type AnyCompensator = Compensator | HoldOnlyCompensator;

export const isHoldOnly = (c: AnyCompensator): c is HoldOnlyCompensator => 'holdOnly' in c && c.holdOnly === true;

export const DAY_MS = 86_400_000;

export class CompensatorError extends Error {
  constructor(
    readonly ref: string,
    readonly problems: string[],
  ) {
    super(`compensator "${ref}" is invalid:\n  - ${problems.join('\n  - ')}`);
    this.name = 'CompensatorError';
  }
}

export function validateCompensator(c: AnyCompensator): string[] {
  const problems: string[] = [];
  if (!/^[a-z][a-z0-9_]*\.[a-z0-9_.]+$/.test(c.ref)) problems.push('ref must look like "<connector>.<thing>.<verb>"');
  if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/.test(c.toolId)) problems.push('toolId must be "<connector>.<tool>"');
  if (isHoldOnly(c)) {
    if (!c.explanation.trim()) problems.push('a hold-only compensator must explain why there is no undo after release');
    return problems;
  }
  if (!Number.isFinite(c.ttlMs) || c.ttlMs <= 0) problems.push('ttlMs must be positive');
  if (c.confidence !== 'EXACT' && c.confidence !== 'APPROXIMATE') problems.push('confidence must be EXACT or APPROXIMATE');
  if (c.sideEffects !== 'SILENT' && c.sideEffects !== 'NOTIFIES_THIRD_PARTY') problems.push('sideEffects must be SILENT or NOTIFIES_THIRD_PARTY');
  if (typeof c.capture !== 'function' || typeof c.compensate !== 'function' || typeof c.describe !== 'function') {
    problems.push('capture(), compensate() and describe() are all required');
  }
  return problems;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function defineCompensator<A = any, P = any>(c: Compensator<A, P>): Compensator<A, P> {
  const problems = validateCompensator(c as AnyCompensator);
  if (problems.length) throw new CompensatorError(c.ref, problems);
  return Object.freeze(c);
}

export function defineHoldOnly(c: Omit<HoldOnlyCompensator, 'holdOnly'>): HoldOnlyCompensator {
  const out: HoldOnlyCompensator = { ...c, holdOnly: true };
  const problems = validateCompensator(out);
  if (problems.length) throw new CompensatorError(c.ref, problems);
  return Object.freeze(out);
}

/** The forward effect's detail, typed by the caller (compensators know their own tool's shape). */
export function forwardDetail<T>(token: CompensationToken): T | null {
  return (token.forward?.detail ?? null) as T | null;
}
