/**
 * THE RISK FUNCTION — docs/module5.md §5.2, PROJECT.md §13.
 *
 * Not a model. A transparent, versioned, unit-testable function a compliance officer can read:
 *
 *   risk = clamp(0, 100,  w1·data_sensitivity + w2·blast_radius + w3·external_exposure
 *                       + w4·irreversibility + w5·authority_gap + w6·taint_pressure
 *                       − w7·certification_credit)
 *
 * Every input is recorded (`factors`) with the weights version, so a stored evaluation
 * reproduces exactly on replay (M7). Hard gates bypass the score and are never overridable by a
 * good one. An LLM may supply an INPUT (a sensitivity hint) — never the score.
 */

export type Tier = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type Taint = 'TRUSTED' | 'ORG' | 'UNTRUSTED';
export type Egress = 'INTERNAL' | 'EXTERNAL' | 'PUBLIC';
export type Reversibility = 'R0' | 'R1' | 'R2' | 'R3';
export type Role = 'OWNER' | 'ADMIN' | 'COMPLIANCE_OFFICER' | 'WORKFLOW_OWNER' | 'APPROVER' | 'MEMBER' | 'AUDITOR';

export interface Weights {
  version: number;
  w1: number;
  w2: number;
  w3: number;
  w4: number;
  w5: number;
  w6: number;
  w7: number;
  boundaries: { low: number; medium: number; high: number };
}

/** The platform default (weights version 1). Calibrated against the §7.3 examples in the tests. */
export const DEFAULT_WEIGHTS: Weights = {
  version: 1,
  w1: 0.3,
  w2: 0.4,
  w3: 0.3,
  w4: 0.35,
  w5: 0.4,
  w6: 0.25,
  w7: 0.2,
  boundaries: { low: 25, medium: 55, high: 80 },
};

/** Tenant tuning is bounded: no weight can be zeroed out or made to dominate (§10). */
export const WEIGHT_BOUNDS: Record<'w1' | 'w2' | 'w3' | 'w4' | 'w5' | 'w6' | 'w7', { min: number; max: number }> = {
  w1: { min: 0.1, max: 0.6 },
  w2: { min: 0.1, max: 0.6 },
  w3: { min: 0.1, max: 0.6 },
  w4: { min: 0.1, max: 0.6 },
  w5: { min: 0.1, max: 0.6 },
  w6: { min: 0.1, max: 0.6 },
  w7: { min: 0, max: 0.4 },
};

export function checkWeights(w: Omit<Weights, 'version'>): string[] {
  const problems: string[] = [];
  for (const k of Object.keys(WEIGHT_BOUNDS) as Array<keyof typeof WEIGHT_BOUNDS>) {
    const b = WEIGHT_BOUNDS[k];
    if (!(w[k] >= b.min && w[k] <= b.max)) problems.push(`${k} must be between ${b.min} and ${b.max}`);
  }
  const { low, medium, high } = w.boundaries;
  if (!(low > 0 && low < medium && medium < high && high < 100)) problems.push('boundaries must satisfy 0 < low < medium < high < 100');
  return problems;
}

export interface RiskInput {
  /** 0–100: classification of generated content plus resource labels (§5.3). */
  sensitivity: number;
  labels: string[];
  effect: { recipients: number; externalRecipients: number; recordsAffected: number; monetaryValue?: { amount: number; currency: string } | undefined };
  egressClass: Egress;
  reversibility: Reversibility;
  principalRole: Role;
  /** Join of every argument's taint (control flow included). */
  argTaint: Taint;
  /** Join of the DATA taint of recipient-class arguments ('TRUSTED' when there are none). */
  recipientTaint: Taint;
  /** Within the principal's granted scope (the agent's tools, the run credential, agents.run). */
  inScope: boolean;
  /** Module 10: demonstrated agreement rate for this action type, 0–100. */
  certification?: { agreementRate: number } | undefined;
}

export interface Factors {
  dataSensitivity: number;
  blastRadius: number;
  externalExposure: number;
  irreversibility: number;
  authorityGap: number;
  taintPressure: number;
  certificationCredit: number;
}

export type HardGate = 'R3_EXTERNAL' | 'UNTRUSTED_RECIPIENT' | 'OUT_OF_SCOPE' | 'RESTRICTED_RESOURCE';

export interface RiskResult {
  score: number;
  /** After hard gates. */
  tier: Tier;
  /** Before hard gates: what the arithmetic alone said. */
  scoreTier: Tier;
  factors: Factors;
  weightsVersion: number;
  hardGates: HardGate[];
  /** One line per factor, for the explanation panel and the reason chain. */
  explanation: Array<{ factor: keyof Factors; value: number; weight: number; contribution: number; text: string }>;
}

export const EXPOSURE: Record<Egress, number> = { INTERNAL: 0, EXTERNAL: 60, PUBLIC: 100 };
export const IRREVERSIBILITY: Record<Reversibility, number> = { R0: 0, R1: 25, R2: 60, R3: 100 };
export const TAINT_PRESSURE: Record<Taint, number> = { TRUSTED: 0, ORG: 40, UNTRUSTED: 100 };
const TIER_ORDER: Tier[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

const clamp = (lo: number, hi: number, v: number) => Math.min(hi, Math.max(lo, v));
// `|| 0` folds −0 into 0: a stored evaluation must compare equal after a JSON round trip.
const round2 = (v: number) => Math.round(v * 100) / 100 || 0;

/** Who and how much: recipients, records touched, money moved — each capped, summed, capped. */
export function blastRadiusScore(effect: RiskInput['effect']): number {
  const people = Math.min(50, 10 * Math.max(0, effect.recipients));
  const records = Math.min(100, 15 * Math.log2(1 + Math.max(0, effect.recordsAffected)));
  const amount = effect.monetaryValue?.amount ?? 0;
  const money = amount >= 100_000 ? 50 : amount >= 10_000 ? 35 : amount >= 1_000 ? 20 : amount > 0 ? 10 : 0;
  return Math.round(clamp(0, 100, people + records + money));
}

/**
 * Authority an action needs, by what it can do; authority a role carries (module1.md §5.3).
 * Members run agents that send and schedule; only owners of workflows and administrators carry
 * irreversible authority; the roles that "cannot execute" carry none. 34 points per level short.
 */
const ROLE_AUTHORITY: Record<Role, number> = { OWNER: 3, ADMIN: 3, WORKFLOW_OWNER: 3, APPROVER: 2, MEMBER: 2, COMPLIANCE_OFFICER: 0, AUDITOR: 0 };
export function requiredAuthority(egress: Egress, reversibility: Reversibility): number {
  if (reversibility === 'R0') return 0;
  if (reversibility === 'R3') return 3;
  return egress === 'INTERNAL' ? 1 : 2;
}
export function authorityGap(role: Role, egress: Egress, reversibility: Reversibility): number {
  return clamp(0, 100, 34 * Math.max(0, requiredAuthority(egress, reversibility) - ROLE_AUTHORITY[role]));
}

export function tierOf(score: number, b: Weights['boundaries']): Tier {
  return score < b.low ? 'LOW' : score < b.medium ? 'MEDIUM' : score < b.high ? 'HIGH' : 'CRITICAL';
}

export function maxTier(a: Tier, b: Tier): Tier {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}

const TEXT: Record<keyof Factors, (v: number, i: RiskInput) => string> = {
  dataSensitivity: (v, i) => (v ? `sensitive content detected${i.labels.length ? ` (${i.labels.join(', ')})` : ''}` : 'no sensitive content detected'),
  blastRadius: (_v, i) =>
    `${i.effect.recipients} recipient(s), ${i.effect.recordsAffected} record(s)${i.effect.monetaryValue ? `, ${i.effect.monetaryValue.amount} ${i.effect.monetaryValue.currency}` : ''}`,
  externalExposure: (_v, i) => ({ INTERNAL: 'stays inside the organization', EXTERNAL: 'goes outside the organization', PUBLIC: 'becomes public' })[i.egressClass],
  irreversibility: (_v, i) => ({ R0: 'R0 — changes nothing', R1: 'R1 — can be undone', R2: 'R2 — held, then final', R3: 'R3 — cannot be undone' })[i.reversibility],
  authorityGap: (v) => (v ? 'beyond the authority your role carries' : 'within your granted authority'),
  taintPressure: (_v, i) => ({ TRUSTED: 'arguments come from you or trusted registries', ORG: 'arguments come from internal systems', UNTRUSTED: 'arguments were influenced by outside content' })[i.argTaint],
  certificationCredit: (v) => (v ? `agreement history credit ${v}` : 'no agreement history yet'),
};

export function scoreRisk(input: RiskInput, weights: Weights = DEFAULT_WEIGHTS): RiskResult {
  const factors: Factors = {
    dataSensitivity: clamp(0, 100, Math.round(input.sensitivity)),
    blastRadius: blastRadiusScore(input.effect),
    externalExposure: EXPOSURE[input.egressClass],
    irreversibility: IRREVERSIBILITY[input.reversibility],
    authorityGap: authorityGap(input.principalRole, input.egressClass, input.reversibility),
    taintPressure: TAINT_PRESSURE[input.argTaint],
    certificationCredit: clamp(0, 100, Math.round(input.certification?.agreementRate ?? 0)),
  };
  const terms: Array<[keyof Factors, number]> = [
    ['dataSensitivity', weights.w1],
    ['blastRadius', weights.w2],
    ['externalExposure', weights.w3],
    ['irreversibility', weights.w4],
    ['authorityGap', weights.w5],
    ['taintPressure', weights.w6],
    ['certificationCredit', -weights.w7],
  ];
  const raw = terms.reduce((sum, [f, w]) => sum + w * factors[f], 0);
  const score = Math.round(clamp(0, 100, raw));
  const scoreTier = tierOf(score, weights.boundaries);

  // Hard gates: evaluated independently of the arithmetic, and only ever raise.
  const hardGates: HardGate[] = [];
  let tier = scoreTier;
  if (input.reversibility === 'R3' && input.egressClass !== 'INTERNAL') {
    hardGates.push('R3_EXTERNAL');
    tier = maxTier(tier, 'HIGH');
  }
  if (input.recipientTaint === 'UNTRUSTED') {
    hardGates.push('UNTRUSTED_RECIPIENT');
    tier = 'CRITICAL';
  }
  if (!input.inScope) {
    hardGates.push('OUT_OF_SCOPE');
    tier = 'CRITICAL';
  }
  if (input.labels.includes('RESTRICTED')) {
    hardGates.push('RESTRICTED_RESOURCE');
    tier = maxTier(tier, 'HIGH');
  }

  return {
    score,
    tier,
    scoreTier,
    factors,
    weightsVersion: weights.version,
    hardGates,
    explanation: terms.map(([f, w]) => ({ factor: f, value: factors[f], weight: Math.abs(w), contribution: round2(w * factors[f]), text: TEXT[f](factors[f], input) })),
  };
}
