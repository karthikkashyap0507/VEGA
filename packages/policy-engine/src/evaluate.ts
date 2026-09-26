import type { Condition, Decision, Policy, Predicate } from './schema.js';

/**
 * The policy INPUT — the facts of one action, as OPA and the reference evaluator see them.
 * Built by the execution plane from the executor's StepContext (M4 §15), the classification and
 * the risk score. Recorded with every evaluation, so simulation replays exactly this.
 */
export interface PolicyInput {
  tool: { id: string; connector: string; egress_class: string; reversibility: string; idempotency: string };
  args: { taint: string; recipient: { taint: string; count: number; domains: string[] } };
  target: { audience: string };
  effect: { recipients: number; external_recipients: number; records: number; monetary_value?: { amount: number; currency: string } | undefined; fidelity: string };
  data: { sensitivity: number; labels: string[] };
  risk: { score: number; tier: string };
  principal: { role: string; id: string };
  agent: { id: string };
  workspace: { id: string };
  run: { trigger: string; cost_cents: number };
  budget: { month_cents: number; month_limit_cents: number; exhausted: boolean };
}

/** A matched policy, as the compiled Rego emits it (same keys, same order of meaning). */
export interface Match {
  id: string;
  version: number;
  decision: Decision;
  approver_role: string | null;
  hold_window_ms: number | null;
  citation: string | null;
  severity: string;
  reason: string | null;
  separation_of_duties: boolean;
}

export function lookup(input: unknown, path: string): unknown {
  let cur: unknown = input;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.hasOwn(cur as object, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Absent → false for every predicate but `exists: false` (and Rego agrees: undefined fails a body). */
export function holds(pred: Predicate, v: unknown): boolean {
  switch (pred.op) {
    case 'exists':
      return pred.value ? v !== undefined && v !== null : v === undefined || v === null;
    case 'eq':
      return v !== undefined && v === pred.value;
    case 'not':
      return v !== undefined && v !== null && v !== pred.value;
    case 'in':
      return v !== undefined && pred.values.includes(v as never);
    case 'not_in':
      return v !== undefined && v !== null && !pred.values.includes(v as never);
    case 'gt':
      return typeof v === 'number' && v > pred.value;
    case 'gte':
      return typeof v === 'number' && v >= pred.value;
    case 'lt':
      return typeof v === 'number' && v < pred.value;
    case 'lte':
      return typeof v === 'number' && v <= pred.value;
    case 'contains':
      return Array.isArray(v) && v.includes(pred.value);
  }
}

export function satisfied(c: Condition, input: unknown): boolean {
  if ('all' in c) return c.all.every((x) => satisfied(x, input));
  if ('any' in c) return c.any.some((x) => satisfied(x, input));
  if ('not' in c) return !satisfied(c.not, input);
  return holds(c.pred, lookup(input, c.field));
}

export function toMatch(p: Policy, version: number): Match {
  return {
    id: p.id,
    version,
    decision: p.then.decision,
    approver_role: p.then.approverRole ?? null,
    hold_window_ms: p.then.holdWindowMs ?? null,
    citation: p.citation ?? null,
    severity: p.severity,
    reason: p.then.reason ?? null,
    separation_of_duties: p.then.separationOfDuties ?? false,
  };
}

/**
 * The REFERENCE evaluator: the language's semantics in TypeScript. Simulation uses it (fast,
 * no OPA round trip per historical action); the differential suite proves the compiled Rego
 * agrees with it on random policies and inputs. Sorted by id so both sides compare as sets.
 */
export function evaluatePolicies(policies: ReadonlyArray<{ policy: Policy; version: number }>, input: PolicyInput): Match[] {
  return policies
    .filter((p) => satisfied(p.policy.when, input))
    .map((p) => toMatch(p.policy, p.version))
    .sort((a, b) => a.id.localeCompare(b.id));
}
