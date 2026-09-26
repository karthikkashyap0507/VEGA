import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * THE POLICY LANGUAGE — docs/module5.md §5.1. Compliance officers author YAML; nobody writes Rego
 * by hand (raw Rego is refused at the API). A policy is a condition over a fixed vocabulary of
 * the action's facts and a disposition:
 *
 *   - id: external-comms-supervision
 *     description: Client-facing communications require principal review
 *     citation: FINRA 2210
 *     severity: high
 *     when:
 *       all:
 *         - tool.egress_class: EXTERNAL
 *         - target.audience: CLIENT
 *     then:
 *       decision: REQUIRE_APPROVAL
 *       approver_role: APPROVER
 *       hold_window: 15m
 *
 * Semantics (identical in the compiled Rego and the reference evaluator, and tested so): a
 * predicate over a field that is absent is FALSE — except `exists: false`. Types are checked
 * against the vocabulary when a policy is saved, not discovered at evaluation.
 */

export const DECISIONS = ['ALLOW', 'ALLOW_WITH_HOLD', 'REQUIRE_APPROVAL', 'REQUIRE_DUAL_APPROVAL', 'DENY'] as const;
export type Decision = (typeof DECISIONS)[number];

/** Most restrictive last. "Most restrictive wins" is defined by this order, nothing else. */
export const RESTRICTIVENESS: Record<Decision, number> = { ALLOW: 0, ALLOW_WITH_HOLD: 1, REQUIRE_APPROVAL: 2, REQUIRE_DUAL_APPROVAL: 3, DENY: 4 };

type FieldType = 'string' | 'number' | 'boolean' | 'string[]';

/** Every fact a policy can test, with its type and (for enumerations) its values. */
export const FIELDS: Record<string, { type: FieldType; values?: readonly string[]; doc: string }> = {
  'tool.id': { type: 'string', doc: 'the tool, e.g. gmail.send' },
  'tool.connector': { type: 'string', doc: 'connector kind, e.g. gmail' },
  'tool.egress_class': { type: 'string', values: ['INTERNAL', 'EXTERNAL', 'PUBLIC'], doc: 'where the effect lands' },
  'tool.reversibility': { type: 'string', values: ['R0', 'R1', 'R2', 'R3'], doc: 'how undoable the effect is' },
  'tool.idempotency': { type: 'string', values: ['NATIVE', 'KEYED', 'NONE'], doc: '' },
  'args.taint': { type: 'string', values: ['TRUSTED', 'ORG', 'UNTRUSTED'], doc: 'join of every argument (control flow included)' },
  'args.recipient.taint': { type: 'string', values: ['TRUSTED', 'ORG', 'UNTRUSTED'], doc: 'data taint of recipient arguments' },
  'args.recipient.count': { type: 'number', doc: 'how many recipients' },
  'args.recipient.domains': { type: 'string[]', doc: 'recipient email domains' },
  'target.audience': { type: 'string', values: ['NONE', 'INTERNAL', 'CLIENT', 'EXTERNAL', 'PUBLIC'], doc: 'CLIENT = every outside recipient is a trusted contact' },
  'effect.recipients': { type: 'number', doc: '' },
  'effect.external_recipients': { type: 'number', doc: '' },
  'effect.records': { type: 'number', doc: 'records created, changed or deleted' },
  'effect.monetary_value.amount': { type: 'number', doc: '' },
  'effect.monetary_value.currency': { type: 'string', doc: '' },
  'effect.fidelity': { type: 'string', values: ['PROVIDER', 'DERIVED', 'DECLARED'], doc: 'how the effect was predicted' },
  'data.sensitivity': { type: 'number', doc: '0–100 from classification' },
  'data.labels': { type: 'string[]', doc: 'PII · PHI · PCI · SECRET · CONFIDENTIAL · RESTRICTED' },
  'risk.score': { type: 'number', doc: '0–100' },
  'risk.tier': { type: 'string', values: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], doc: '' },
  'principal.role': { type: 'string', values: ['OWNER', 'ADMIN', 'COMPLIANCE_OFFICER', 'WORKFLOW_OWNER', 'APPROVER', 'MEMBER', 'AUDITOR'], doc: '' },
  'principal.id': { type: 'string', doc: '' },
  'agent.id': { type: 'string', doc: '' },
  'workspace.id': { type: 'string', doc: '' },
  'run.trigger': { type: 'string', values: ['chat', 'schedule', 'webhook', 'api', 'test'], doc: '' },
  'run.cost_cents': { type: 'number', doc: 'spent by this run so far' },
  'budget.month_cents': { type: 'number', doc: 'spent by the tenant this month' },
  'budget.month_limit_cents': { type: 'number', doc: 'the tenant monthly cap (0 = none)' },
  'budget.exhausted': { type: 'boolean', doc: 'the monthly cap is reached' },
};

export type Scalar = string | number | boolean;

export type Predicate =
  | { op: 'eq'; value: Scalar }
  | { op: 'not'; value: Scalar }
  | { op: 'in'; values: Scalar[] }
  | { op: 'not_in'; values: Scalar[] }
  | { op: 'gt' | 'gte' | 'lt' | 'lte'; value: number }
  | { op: 'contains'; value: string }
  | { op: 'exists'; value: boolean };

export type Condition = { all: Condition[] } | { any: Condition[] } | { not: Condition } | { field: string; pred: Predicate };

export interface Then {
  decision: Decision;
  approverRole?: string | undefined;
  holdWindowMs?: number | undefined;
  reason?: string | undefined;
  evidence?: string[] | undefined;
  separationOfDuties?: boolean | undefined;
}

export interface Policy {
  id: string;
  description: string;
  citation?: string | undefined;
  severity: 'low' | 'normal' | 'high' | 'critical';
  when: Condition;
  then: Then;
}

export class PolicyError extends Error {
  constructor(readonly problems: Array<{ path: string; message: string }>) {
    super(problems.map((p) => `${p.path}: ${p.message}`).join('; '));
    this.name = 'PolicyError';
  }
}

const DURATION = /^(\d+)(ms|s|m|h|d)$/;
export function durationMs(s: string): number {
  const m = DURATION.exec(s);
  if (!m) throw new Error(`not a duration: ${s}`);
  const n = Number(m[1]);
  return n * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'ms' | 's' | 'm' | 'h' | 'd'];
}

const Raw = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/, 'ids are kebab-case, 2–64 characters'),
  description: z.string().min(1).max(500),
  citation: z.string().max(200).optional(),
  severity: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
  when: z.unknown(),
  then: z.object({
    decision: z.enum(DECISIONS),
    approver_role: z.string().regex(/^[A-Z_]{2,40}$/).optional(),
    hold_window: z.string().regex(DURATION).optional(),
    reason: z.string().max(500).optional(),
    evidence: z.array(z.string().max(100)).max(20).optional(),
    separation_of_duties: z.boolean().optional(),
  }).strict(),
}).strict();

const isScalar = (v: unknown): v is Scalar => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

function parsePredicate(field: string, raw: unknown, path: string, problems: Array<{ path: string; message: string }>): Predicate | undefined {
  const f = FIELDS[field];
  if (!f) {
    problems.push({ path, message: `unknown field "${field}" (known: ${Object.keys(FIELDS).join(', ')})` });
    return undefined;
  }
  const typeOk = (v: unknown) => (f.type === 'number' ? typeof v === 'number' : f.type === 'boolean' ? typeof v === 'boolean' : typeof v === 'string');
  const valueOk = (v: unknown) => typeOk(v) && (!f.values || f.values.includes(v as string));
  const bad = (m: string) => (problems.push({ path, message: m }), undefined);
  if (isScalar(raw)) {
    if (f.type === 'string[]') return bad(`${field} is a list: use { contains: … }`);
    return valueOk(raw) ? { op: 'eq', value: raw } : bad(`${JSON.stringify(raw)} is not a valid ${field}${f.values ? ` (${f.values.join(' | ')})` : ''}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 1) return bad('a predicate is a value or one of { not | in | not_in | gt | gte | lt | lte | contains | exists }');
  const [op, v] = Object.entries(raw)[0]!;
  switch (op) {
    case 'not':
      return f.type !== 'string[]' && valueOk(v) ? { op: 'not', value: v as Scalar } : bad(`not: ${JSON.stringify(v)} is not a valid ${field}`);
    case 'in':
    case 'not_in':
      return Array.isArray(v) && v.length > 0 && v.length <= 100 && v.every(valueOk) && f.type !== 'string[]' ? { op, values: v as Scalar[] } : bad(`${op}: a non-empty list of valid ${field} values`);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return f.type === 'number' && typeof v === 'number' ? { op, value: v } : bad(`${op} applies to numbers; ${field} is ${f.type}`);
    case 'contains':
      return f.type === 'string[]' && typeof v === 'string' ? { op: 'contains', value: v } : bad(`contains applies to lists; ${field} is ${f.type}`);
    case 'exists':
      return typeof v === 'boolean' ? { op: 'exists', value: v } : bad('exists: true | false');
    default:
      return bad(`unknown predicate "${op}"`);
  }
}

function parseCondition(raw: unknown, path: string, problems: Array<{ path: string; message: string }>, depth = 0): Condition | undefined {
  if (depth > 8) return (problems.push({ path, message: 'conditions nest at most 8 deep' }), undefined);
  if (Array.isArray(raw)) return parseCondition({ all: raw }, path, problems, depth);
  if (!raw || typeof raw !== 'object') return (problems.push({ path, message: 'a condition is { all | any | not } or { field: predicate }' }), undefined);
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1 && (keys[0] === 'all' || keys[0] === 'any')) {
    const list = o[keys[0]];
    if (!Array.isArray(list) || list.length === 0 || list.length > 50) return (problems.push({ path: `${path}.${keys[0]}`, message: 'a non-empty list (at most 50)' }), undefined);
    const children = list.map((c, i) => parseCondition(c, `${path}.${keys[0]}[${i}]`, problems, depth + 1));
    return children.every(Boolean) ? (keys[0] === 'all' ? { all: children as Condition[] } : { any: children as Condition[] }) : undefined;
  }
  if (keys.length === 1 && keys[0] === 'not') {
    const c = parseCondition(o['not'], `${path}.not`, problems, depth + 1);
    return c ? { not: c } : undefined;
  }
  // A map of field: predicate — several keys mean all of them (PROJECT.md §7.3 shorthand).
  const leaves = keys.map((k) => {
    const pred = parsePredicate(k, o[k], `${path}.${k}`, problems);
    return pred ? ({ field: k, pred } as Condition) : undefined;
  });
  if (!leaves.every(Boolean)) return undefined;
  return leaves.length === 1 ? leaves[0] : { all: leaves as Condition[] };
}

/** Parses and validates one policy object (from YAML or JSON). Throws PolicyError with every problem. */
export function parsePolicy(raw: unknown, path = 'policy'): Policy {
  const r = Raw.safeParse(raw);
  if (!r.success) throw new PolicyError(r.error.issues.map((i) => ({ path: [path, ...i.path.map(String)].join('.'), message: i.message })));
  const problems: Array<{ path: string; message: string }> = [];
  const when = parseCondition(r.data.when, `${path}.when`, problems);
  const t = r.data.then;
  if ((t.decision === 'REQUIRE_APPROVAL' || t.decision === 'REQUIRE_DUAL_APPROVAL') && !t.approver_role) problems.push({ path: `${path}.then.approver_role`, message: 'approval decisions name the approver role' });
  if (t.decision === 'ALLOW_WITH_HOLD' && !t.hold_window) problems.push({ path: `${path}.then.hold_window`, message: 'a hold names its window (e.g. 15m)' });
  if (t.decision === 'DENY' && !t.reason) problems.push({ path: `${path}.then.reason`, message: 'a denial says why' });
  if (problems.length || !when) throw new PolicyError(problems);
  return {
    id: r.data.id,
    description: r.data.description,
    ...(r.data.citation ? { citation: r.data.citation } : {}),
    severity: r.data.severity,
    when,
    then: {
      decision: t.decision,
      ...(t.approver_role ? { approverRole: t.approver_role } : {}),
      ...(t.hold_window ? { holdWindowMs: durationMs(t.hold_window) } : {}),
      ...(t.reason ? { reason: t.reason } : {}),
      ...(t.evidence ? { evidence: t.evidence } : {}),
      ...(t.separation_of_duties ? { separationOfDuties: true } : {}),
    },
  };
}

/** A YAML document holding one policy or a list of them. */
export function parsePolicyYaml(source: string): Policy[] {
  if (/^\s*package\s+\w/m.test(source) && !/^\s*-?\s*id:/m.test(source)) throw new PolicyError([{ path: 'source', message: 'raw Rego is not accepted: author policies in YAML' }]);
  let doc: unknown;
  try {
    doc = parseYaml(source, { maxAliasCount: 0 });
  } catch (e) {
    throw new PolicyError([{ path: 'yaml', message: e instanceof Error ? e.message : 'unparseable YAML' }]);
  }
  const list = Array.isArray(doc) ? doc : [doc];
  const policies = list.map((p, i) => parsePolicy(p, `policies[${i}]`));
  const ids = policies.map((p) => p.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new PolicyError([{ path: 'policies', message: `duplicate id ${dup}` }]);
  return policies;
}
