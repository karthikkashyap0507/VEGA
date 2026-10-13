import { createHash } from 'node:crypto';

/**
 * THE LADDER — docs/module10.md §2, §7. One tier per (workflow × action type), independent of
 * every other pair: an agent can be AUTONOMOUS for calendar updates and SUPERVISED for client
 * emails, and the two never share a setting.
 *
 *   SHADOW      decides, never acts — every call is routed to a person, same as SUPERVISED
 *               (this codebase has no channel for "what the human did instead" outside the
 *               agent, so SHADOW and SUPERVISED share enforcement; certification scores them
 *               from the same override corpus — see certification.ts)
 *   SUPERVISED  acts only after explicit approval
 *   SAMPLED     acts; 1-in-N routed for review (deterministic, not random — see `sample`)
 *   AUTONOMOUS  acts; policy's own decision stands, nothing added
 *   SUSPENDED   blocked outright, pending investigation
 *
 * `workflow_key` is the agent's id: this codebase has no separate "objective template" entity,
 * and an agent is the versioned, certifiable unit §11 describes ("changing one resets
 * certification" — exactly what agent_versions already tracks).
 */
export const TIERS = ['SHADOW', 'SUPERVISED', 'SAMPLED', 'AUTONOMOUS', 'SUSPENDED'] as const;
export type Tier = (typeof TIERS)[number];

/** For "demote fast, promote slow" (§21 hysteresis): only these moves are ever a promotion. */
const PROMOTION_FROM: Record<Tier, Tier | null> = { SHADOW: null, SUPERVISED: 'SHADOW', SAMPLED: 'SUPERVISED', AUTONOMOUS: 'SAMPLED', SUSPENDED: null };
export function isPromotion(from: Tier, to: Tier): boolean {
  return PROMOTION_FROM[to] === from;
}

export type Disposition = 'ALLOW' | 'ALLOW_WITH_HOLD' | 'HOLD' | 'REQUIRE_APPROVAL' | 'REQUIRE_DUAL_APPROVAL' | 'DENY';
const RANK: Record<Disposition, number> = { ALLOW: 0, ALLOW_WITH_HOLD: 1, HOLD: 1, REQUIRE_APPROVAL: 2, REQUIRE_DUAL_APPROVAL: 3, DENY: 4 };

/** The more restrictive of two dispositions — the same "worse one wins" fold used throughout the executor. */
export function stricter(a: Disposition, b: Disposition): Disposition {
  return RANK[b] > RANK[a] ? b : a;
}

/**
 * §7: "autonomy may only downgrade a disposition, never upgrade it. If policy says
 * REQUIRE_APPROVAL, AUTONOMOUS does not override it." The floor below is autonomy's OWN opinion,
 * absent any policy input; folding it against the real policy decision with `stricter` is what
 * makes the rule hold — it can only ever make a step MORE supervised than policy alone would.
 */
const FLOOR: Record<Tier, Disposition | null> = {
  SUSPENDED: 'DENY',
  SHADOW: 'REQUIRE_APPROVAL',
  SUPERVISED: 'REQUIRE_APPROVAL',
  SAMPLED: null, // resolved per call by `sample()` below
  AUTONOMOUS: null,
};

/**
 * Deterministic 1-in-N (§2): a hash of the call's own identity, not a random draw — the same
 * call replayed (crash recovery, DRY replay) samples the same way every time.
 */
export function sample(key: string, rate: number): boolean {
  if (rate <= 1) return true;
  const h = createHash('sha256').update(key).digest();
  return h.readUInt32BE(0) % rate === 0;
}

export interface LadderInput {
  tier: Tier;
  sampleRate: number | null;
  /** Stable per call, e.g. `${runId}:${callSeq}` — what `sample()` hashes. */
  sampleKey: string;
}

export interface LadderResult {
  /** The floor this tier adds, folded with policy's own decision by the caller via `stricter`. */
  floor: Disposition | null;
  sampled: boolean;
  tier: Tier;
}

/** No row for this (workflow, action) pair: autonomy adds nothing — §1 "blocks nothing" by default. */
export const UNTIERED: LadderResult = { floor: null, sampled: false, tier: 'AUTONOMOUS' };

export function evaluate(input: LadderInput): LadderResult {
  if (input.tier === 'SAMPLED') {
    const sampled = sample(input.sampleKey, input.sampleRate ?? 5);
    return { floor: sampled ? 'REQUIRE_APPROVAL' : null, sampled, tier: input.tier };
  }
  return { floor: FLOOR[input.tier], sampled: false, tier: input.tier };
}

/** SUSPENDED > SHADOW = SUPERVISED > SAMPLED > AUTONOMOUS. A "demotion" must move strictly up this scale. */
const RESTRICTIVENESS: Record<Tier, number> = { AUTONOMOUS: 0, SAMPLED: 1, SUPERVISED: 2, SHADOW: 2, SUSPENDED: 3 };
export function moreRestrictive(from: Tier, to: Tier): boolean {
  return RESTRICTIVENESS[to] > RESTRICTIVENESS[from];
}
