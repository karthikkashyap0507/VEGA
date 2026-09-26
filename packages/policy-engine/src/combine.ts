import type { HardGate, RiskResult, Tier } from '@vega/risk';
import type { Match } from './evaluate.js';
import { RESTRICTIVENESS, type Decision } from './schema.js';

/**
 * DECISION COMBINATION — docs/module5.md §5.4. The invariant: MOST RESTRICTIVE WINS. There is no
 * precedence order in which a permissive rule can shadow a restrictive one; the property suite
 * generates random policy sets and scores and asserts the result is never less restrictive than
 * any input.
 *
 * Candidates, all of which compete on restrictiveness alone:
 *   · every matched policy
 *   · every hard gate (untrusted recipient / out of scope → DENY; RESTRICTED → dual approval)
 *   · the tier's default disposition — when no policy matched, and ALWAYS at HIGH and CRITICAL
 *     (a matched ALLOW may relax a MEDIUM tier's hold; nothing relaxes a HIGH tier's approval)
 *
 * The reason chain is written for a person: it is rendered verbatim in the approval packet (M8)
 * and the audit trace (M7).
 */

export const TIER_DEFAULT: Record<Tier, { decision: Decision; approverRole?: string; holdWindowMs?: number }> = {
  LOW: { decision: 'ALLOW' },
  MEDIUM: { decision: 'ALLOW_WITH_HOLD', holdWindowMs: 120_000 },
  HIGH: { decision: 'REQUIRE_APPROVAL', approverRole: 'APPROVER' },
  CRITICAL: { decision: 'DENY' },
};

export interface ChainStep {
  step: 'risk' | 'gate' | 'policy' | 'tier' | 'combine' | 'autonomy' | 'engine';
  detail: string;
  id?: string;
  version?: number;
  citation?: string;
}

export interface CombinedDecision {
  decision: Decision;
  approverRole: string | null;
  /** Two distinct approvers (REQUIRE_DUAL_APPROVAL). */
  dual: boolean;
  /** The run's principal may not be one of the approvers. */
  separationOfDuties: boolean;
  /** For ALLOW_WITH_HOLD (and a post-approval hold): policy wins over the tier default. */
  holdWindowMs: number | null;
  riskTier: Tier;
  riskScore: number;
  matched: Match[];
  chain: ChainStep[];
  /**
   * The rule that decided: a policy (its id and version), or `(hard-gate:<GATE>)`,
   * `(tier-default:<TIER>)`, `(fail-closed)` with version 0. When several tie on
   * restrictiveness, the first in chain order (gates, then policies by severity, then the tier).
   */
  decidedBy: { key: string; version: number };
  /** The engine could not decide (OPA down, classification failed): DENY, loudly. */
  failClosed?: boolean;
}

interface Candidate {
  decision: Decision;
  approverRole?: string | null;
  holdWindowMs?: number | null;
  separationOfDuties?: boolean;
  source: string;
  ref: { key: string; version: number };
}

const GATE_TEXT: Record<HardGate, string> = {
  R3_EXTERNAL: 'irreversible and leaves the organization: at least HIGH',
  UNTRUSTED_RECIPIENT: 'a recipient was derived from untrusted content: denied, always',
  OUT_OF_SCOPE: 'outside the principal’s granted scope: denied, always',
  RESTRICTED_RESOURCE: 'a RESTRICTED resource: two approvers at least',
};

const GATE_DECISION: Partial<Record<HardGate, Omit<Candidate, 'ref'>>> = {
  UNTRUSTED_RECIPIENT: { decision: 'DENY', source: 'hard gate' },
  OUT_OF_SCOPE: { decision: 'DENY', source: 'hard gate' },
  RESTRICTED_RESOURCE: { decision: 'REQUIRE_DUAL_APPROVAL', approverRole: 'ADMIN', separationOfDuties: true, source: 'hard gate' },
};

const PLAIN: Record<Decision, string> = {
  ALLOW: 'allowed',
  ALLOW_WITH_HOLD: 'allowed after a hold window',
  REQUIRE_APPROVAL: 'requires approval',
  REQUIRE_DUAL_APPROVAL: 'requires two approvals',
  DENY: 'denied',
};

const minutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)}-minute` : `${Math.round(ms / 1000)}-second`);

function riskLine(r: RiskResult): string {
  const top = [...r.explanation]
    .filter((e) => e.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3)
    .map((e) => `${e.text} (${e.value})`);
  return `score ${r.score} (${r.tier}${r.tier !== r.scoreTier ? `, raised from ${r.scoreTier} by a hard gate` : ''}): ${top.join('; ') || 'nothing notable'}`;
}

export function combine(risk: RiskResult, matches: Match[]): CombinedDecision {
  const chain: ChainStep[] = [{ step: 'risk', detail: riskLine(risk) }];
  const candidates: Candidate[] = [];

  for (const g of risk.hardGates) {
    chain.push({ step: 'gate', id: g, detail: GATE_TEXT[g] });
    const c = GATE_DECISION[g];
    if (c) candidates.push({ ...c, ref: { key: `(hard-gate:${g})`, version: 0 } });
  }
  // Most severe first: when two match at the same level, the more severe one's attributes lead.
  const SEV = { critical: 0, high: 1, normal: 2, low: 3 } as Record<string, number>;
  const ordered = [...matches].sort((a, b) => (SEV[a.severity] ?? 2) - (SEV[b.severity] ?? 2) || a.id.localeCompare(b.id));
  for (const m of ordered) {
    chain.push({
      step: 'policy',
      id: m.id,
      version: m.version,
      ...(m.citation ? { citation: m.citation } : {}),
      detail: `${m.id}${m.citation ? ` (${m.citation})` : ''} → ${PLAIN[m.decision]}${m.approver_role ? ` by ${m.approver_role}` : ''}${m.hold_window_ms ? `, ${minutes(m.hold_window_ms)} hold` : ''}${m.reason ? `: ${m.reason}` : ''}`,
    });
    candidates.push({ decision: m.decision, approverRole: m.approver_role, holdWindowMs: m.hold_window_ms, separationOfDuties: m.separation_of_duties, source: `policy ${m.id}`, ref: { key: m.id, version: m.version } });
  }
  const tierBinds = matches.length === 0 || risk.tier === 'HIGH' || risk.tier === 'CRITICAL';
  const td = TIER_DEFAULT[risk.tier];
  if (tierBinds) {
    candidates.push({ decision: td.decision, approverRole: td.approverRole ?? null, holdWindowMs: td.holdWindowMs ?? null, source: `the ${risk.tier} tier default`, ref: { key: `(tier-default:${risk.tier})`, version: 0 } });
    chain.push({ step: 'tier', detail: `${risk.tier} → ${PLAIN[td.decision]}${matches.length ? ' (applies at HIGH and above whatever policies match)' : ' (no policy matched)'}` });
  }

  const level = Math.max(...candidates.map((c) => RESTRICTIVENESS[c.decision]));
  const winners = candidates.filter((c) => RESTRICTIVENESS[c.decision] === level);
  const decision = winners[0]!.decision;
  const approverRole = winners.find((c) => c.approverRole)?.approverRole ?? (decision === 'REQUIRE_APPROVAL' || decision === 'REQUIRE_DUAL_APPROVAL' ? 'APPROVER' : null);
  // A hold's window: the longest a matched policy set; the tier's only if no policy set one.
  const policyHolds = ordered.map((m) => m.hold_window_ms).filter((h): h is number => typeof h === 'number');
  const holdWindowMs = decision === 'DENY' ? null : policyHolds.length ? Math.max(...policyHolds) : decision === 'ALLOW_WITH_HOLD' ? (td.holdWindowMs ?? TIER_DEFAULT.MEDIUM.holdWindowMs!) : null;
  const separationOfDuties = winners.some((c) => c.separationOfDuties) || (decision === 'REQUIRE_DUAL_APPROVAL' && candidates.some((c) => c.separationOfDuties));
  chain.push({
    step: 'combine',
    detail:
      winners.length === candidates.length
        ? `${PLAIN[decision]} (${winners.map((w) => w.source).join(', ')})`
        : `${PLAIN[decision]}: ${winners.map((w) => w.source).join(', ')} is more restrictive than ${candidates
            .filter((c) => !winners.includes(c))
            .map((c) => c.source)
            .join(', ')} — the most restrictive always wins`,
  });
  chain.push({ step: 'autonomy', detail: 'autonomy tier SHADOW/SUPERVISED (Module 10): no change applied' });

  return {
    decision,
    approverRole,
    dual: decision === 'REQUIRE_DUAL_APPROVAL',
    separationOfDuties,
    holdWindowMs,
    riskTier: risk.tier,
    riskScore: risk.score,
    matched: ordered,
    chain,
    decidedBy: winners[0]!.ref,
  };
}

/** What the engine answers when it cannot decide. Never permissive. */
export function failClosed(reason: string, risk?: RiskResult): CombinedDecision {
  return {
    decision: 'DENY',
    approverRole: null,
    dual: false,
    separationOfDuties: false,
    holdWindowMs: null,
    riskTier: risk?.tier ?? 'CRITICAL',
    riskScore: risk?.score ?? 100,
    matched: [],
    chain: [{ step: 'engine', detail: `the policy engine could not decide (${reason}): denied — the engine never fails open` }],
    decidedBy: { key: '(fail-closed)', version: 0 },
    failClosed: true,
  };
}
