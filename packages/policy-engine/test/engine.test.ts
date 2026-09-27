import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { scoreRisk, type RiskInput } from '@vega/risk';
import {
  buildBundle,
  combine,
  compileModule,
  evaluatePolicies,
  failClosed,
  OpaClient,
  parsePolicy,
  parsePolicyYaml,
  PolicyError,
  PRESET_MODES,
  presetPolicies,
  publicPem,
  RESTRICTIVENESS,
  routeModel,
  RoutingRefused,
  signingKeyFromPem,
  type Condition,
  type Decision,
  type Match,
  type Policy,
  type PolicyInput,
} from '../src/index.js';
import { goldens } from '../scripts/golden.js';

/**
 * The policy engine (docs/module5.md §11): language validation, compiler golden files, the
 * most-restrictive-wins property, the compiled Rego DIFFERENTIALLY against the reference
 * evaluator on a real OPA, and signed bundles verified (and tampering refused) by OPA itself.
 */

const OPA = process.env['OPA_TEST_URL'] ?? 'http://localhost:8182';
const OPA_IMAGE = process.env['OPA_IMAGE'] ?? 'mirror.gcr.io/openpolicyagent/opa:1.10.1-static';
const here = dirname(fileURLToPath(import.meta.url));
const opa = new OpaClient({ baseUrl: OPA, timeoutMs: 5_000 });

/** A scratch dir the (non-root) OPA container can read when bind-mounted. */
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o755);
  return dir;
}

const input = (patch: Partial<Record<keyof PolicyInput, unknown>> = {}): PolicyInput =>
  ({
    tool: { id: 'gmail.send', connector: 'gmail', egress_class: 'EXTERNAL', reversibility: 'R2', idempotency: 'KEYED' },
    args: { taint: 'TRUSTED', recipient: { taint: 'TRUSTED', count: 1, domains: ['partner.example'] } },
    target: { audience: 'CLIENT' },
    effect: { recipients: 1, external_recipients: 1, records: 1, fidelity: 'DERIVED' },
    data: { sensitivity: 10, labels: [] },
    risk: { score: 40, tier: 'MEDIUM' },
    principal: { role: 'MEMBER', id: 'u1' },
    agent: { id: 'a1' },
    workspace: { id: 'w1' },
    run: { trigger: 'chat', cost_cents: 3 },
    budget: { month_cents: 100, month_limit_cents: 0, exhausted: false },
    ...patch,
  }) as PolicyInput;

describe('the policy language', () => {
  it('accepts the documented examples and the §7.3 shorthand', () => {
    const [p] = parsePolicyYaml(`
- id: external-comms-supervision
  description: Client-facing communications require principal review
  citation: FINRA 2210
  severity: high
  when:
    tool.egress_class: EXTERNAL
    target.audience: CLIENT
  then:
    decision: REQUIRE_APPROVAL
    approver_role: APPROVER
    hold_window: 15m
    evidence: [draft_body, source_provenance]`);
    expect(p).toMatchObject({ id: 'external-comms-supervision', then: { decision: 'REQUIRE_APPROVAL', holdWindowMs: 900_000 } });
    expect('all' in p!.when && p!.when.all).toHaveLength(2);
  });

  it.each([
    ['an unknown field', { id: 'x-1', description: 'd', when: { 'tool.colour': 'red' }, then: { decision: 'ALLOW' } }, /unknown field/],
    ['a value outside the enumeration', { id: 'x-1', description: 'd', when: { 'tool.reversibility': 'R9' }, then: { decision: 'ALLOW' } }, /not a valid/],
    ['a number comparison on a string', { id: 'x-1', description: 'd', when: { 'tool.id': { gte: 3 } }, then: { decision: 'ALLOW' } }, /numbers/],
    ['an approval with no approver', { id: 'x-1', description: 'd', when: { 'tool.id': 'a.b' }, then: { decision: 'REQUIRE_APPROVAL' } }, /approver role/],
    ['a hold with no window', { id: 'x-1', description: 'd', when: { 'tool.id': 'a.b' }, then: { decision: 'ALLOW_WITH_HOLD' } }, /window/],
    ['a denial with no reason', { id: 'x-1', description: 'd', when: { 'tool.id': 'a.b' }, then: { decision: 'DENY' } }, /says why/],
    ['a misspelt key', { id: 'x-1', description: 'd', when: { 'tool.id': 'a.b' }, then: { decision: 'ALLOW', approve_role: 'X' } }, /nrecognized/],
  ])('rejects %s', (_n, raw, message) => {
    expect(() => parsePolicy(raw)).toThrow(message);
  });

  it('refuses raw Rego outright: YAML is the only authoring path', () => {
    expect(() => parsePolicyYaml('package vega.x\nallow := true')).toThrow(PolicyError);
  });
});

describe('the compiler (golden files)', () => {
  it('is deterministic and matches the committed golden output', () => {
    const now = goldens();
    for (const [name, rego] of Object.entries(now)) {
      expect(rego, `${name} changed: run pnpm --filter @vega/policy-engine golden:update and review the diff`).toBe(readFileSync(join(here, 'golden', name), 'utf8'));
    }
    expect(goldens()).toEqual(now);
  });

  it('every golden module parses and type-checks in OPA', () => {
    const dir = scratch('rego-');
    for (const [name, rego] of Object.entries(goldens())) writeFileSync(join(dir, name), rego, { mode: 0o644 });
    execFileSync('docker', ['run', '--rm', '-v', `${dir}:/p`, OPA_IMAGE, 'check', '--strict', '/p'], { stdio: 'pipe' });
  });

  it('the Rego unit tests (test/rego/*_test.rego) pass in OPA against the golden modules', () => {
    const dir = scratch('rego-test-');
    for (const [name, rego] of Object.entries(goldens())) writeFileSync(join(dir, name), rego);
    for (const name of readdirSync(join(here, 'rego'))) writeFileSync(join(dir, name), readFileSync(join(here, 'rego', name)));
    for (const name of readdirSync(dir)) chmodSync(join(dir, name), 0o644);
    const out = execFileSync('docker', ['run', '--rm', '-v', `${dir}:/p`, OPA_IMAGE, 'test', '/p', '--format', 'json'], { stdio: 'pipe' }).toString();
    const results = JSON.parse(out) as Array<{ name: string; fail?: boolean; error?: unknown }>;
    expect(results.length).toBeGreaterThanOrEqual(15);
    expect(results.filter((r) => r.fail || r.error).map((r) => r.name)).toEqual([]);
  });
});

describe('combination (property-based, BLOCKING): the most restrictive always wins', () => {
  const DECISION = fc.constantFrom<Decision>('ALLOW', 'ALLOW_WITH_HOLD', 'REQUIRE_APPROVAL', 'REQUIRE_DUAL_APPROVAL', 'DENY');
  const match = (d: Decision, i: number): Match => ({
    id: `p-${i}`,
    version: 1,
    decision: d,
    approver_role: d === 'REQUIRE_APPROVAL' || d === 'REQUIRE_DUAL_APPROVAL' ? 'APPROVER' : null,
    hold_window_ms: d === 'ALLOW_WITH_HOLD' ? 60_000 : null,
    citation: null,
    severity: 'normal',
    reason: d === 'DENY' ? 'no' : null,
    separation_of_duties: false,
  });
  const riskInput = fc.record({
    sensitivity: fc.integer({ min: 0, max: 100 }),
    labels: fc.subarray(['PII', 'RESTRICTED', 'SECRET']),
    effect: fc.record({ recipients: fc.nat(20), externalRecipients: fc.nat(20), recordsAffected: fc.nat(500) }),
    egressClass: fc.constantFrom('INTERNAL', 'EXTERNAL', 'PUBLIC'),
    reversibility: fc.constantFrom('R0', 'R1', 'R2', 'R3'),
    principalRole: fc.constantFrom('OWNER', 'MEMBER', 'APPROVER'),
    argTaint: fc.constantFrom('TRUSTED', 'ORG', 'UNTRUSTED'),
    recipientTaint: fc.constantFrom('TRUSTED', 'ORG', 'UNTRUSTED'),
    inScope: fc.boolean(),
  }) as fc.Arbitrary<RiskInput>;

  it('never less restrictive than any matched policy, any hard gate, or a HIGH/CRITICAL tier', () => {
    fc.assert(
      fc.property(riskInput, fc.array(DECISION, { maxLength: 8 }), (ri, decisions) => {
        const risk = scoreRisk(ri);
        const out = combine(risk, decisions.map(match));
        const level = RESTRICTIVENESS[out.decision];
        for (const d of decisions) expect(level).toBeGreaterThanOrEqual(RESTRICTIVENESS[d]);
        if (risk.hardGates.includes('UNTRUSTED_RECIPIENT') || risk.hardGates.includes('OUT_OF_SCOPE')) expect(out.decision).toBe('DENY');
        if (risk.hardGates.includes('RESTRICTED_RESOURCE')) expect(level).toBeGreaterThanOrEqual(RESTRICTIVENESS.REQUIRE_DUAL_APPROVAL);
        if (risk.tier === 'HIGH') expect(level).toBeGreaterThanOrEqual(RESTRICTIVENESS.REQUIRE_APPROVAL);
        if (risk.tier === 'CRITICAL') expect(out.decision).toBe('DENY');
        if (!decisions.length && risk.tier === 'MEDIUM') expect(level).toBeGreaterThanOrEqual(RESTRICTIVENESS.ALLOW_WITH_HOLD);
        // A permissive rule never shadows a restrictive one, whatever order they arrive in.
        expect(combine(risk, [...decisions].reverse().map(match)).decision).toBe(out.decision);
        expect(out.chain.at(-2)?.step).toBe('combine');
      }),
      { numRuns: 2_000 },
    );
  });

  it('the reason chain reads like the §5.5 example', () => {
    // HIGH, not CRITICAL: with the v1 weights an untrusted-derived argument on top would be CRITICAL.
    const risk = scoreRisk({ sensitivity: 35, labels: [], effect: { recipients: 2, externalRecipients: 2, recordsAffected: 1 }, egressClass: 'EXTERNAL', reversibility: 'R2', principalRole: 'MEMBER', argTaint: 'TRUSTED', recipientTaint: 'TRUSTED', inScope: true });
    const out = combine(risk, [{ ...match('REQUIRE_APPROVAL', 1), id: 'external-comms-supervision', version: 7, citation: 'FINRA 2210', hold_window_ms: 900_000 }]);
    expect(out).toMatchObject({ decision: 'REQUIRE_APPROVAL', approverRole: 'APPROVER', holdWindowMs: 900_000 });
    expect(out.chain.map((c) => c.step)).toEqual(['risk', 'policy', 'tier', 'combine', 'autonomy']);
    expect(out.chain[0]!.detail).toMatch(/^score \d+ \(HIGH\): /);
    expect(out.chain[1]).toMatchObject({ id: 'external-comms-supervision', version: 7, citation: 'FINRA 2210' });
  });

  it('fails closed: an engine that cannot decide denies', () => {
    expect(failClosed('OPA unreachable')).toMatchObject({ decision: 'DENY', failClosed: true });
  });
});

describe('presets (§5.7)', () => {
  const at = (tool: Partial<PolicyInput['tool']>, extra: Partial<Record<keyof PolicyInput, unknown>> = {}) => input({ tool: { ...input().tool, ...tool }, ...extra });
  it.each(PRESET_MODES)('%s: no preset ever permits an untrusted recipient', (mode) => {
    const m = evaluatePolicies(presetPolicies(mode), at({}, { args: { taint: 'UNTRUSTED', recipient: { taint: 'UNTRUSTED', count: 1, domains: [] } } }));
    expect(m.map((x) => x.decision)).toContain('DENY');
  });
  it('the three modes differ exactly where the table says', () => {
    const ext = at({});
    const decide = (mode: (typeof PRESET_MODES)[number], i: PolicyInput) => combine(scoreRisk({ sensitivity: 10, labels: [], effect: { recipients: 1, externalRecipients: 1, recordsAffected: 1 }, egressClass: i.tool.egress_class as 'EXTERNAL', reversibility: i.tool.reversibility as 'R2', principalRole: 'MEMBER', argTaint: 'TRUSTED', recipientTaint: 'TRUSTED', inScope: true }), evaluatePolicies(presetPolicies(mode), i));
    expect(decide('cautious', ext)).toMatchObject({ decision: 'REQUIRE_APPROVAL', holdWindowMs: 300_000 });
    expect(decide('balanced', ext)).toMatchObject({ decision: 'ALLOW_WITH_HOLD', holdWindowMs: 120_000 });
    expect(decide('fast', ext)).toMatchObject({ decision: 'ALLOW_WITH_HOLD', holdWindowMs: 30_000 });
    const draft = at({ id: 'gmail.draft', egress_class: 'INTERNAL', reversibility: 'R1' });
    expect(decide('balanced', draft).decision).toBe('ALLOW');
    expect(decide('cautious', draft).decision).toBe('ALLOW_WITH_HOLD');
  });
});

// ------------------------------------------------------------------ differential: Rego ≡ reference
const FIELD_GEN: Array<{ field: string; values: fc.Arbitrary<unknown>; kind: 'enum' | 'num' | 'list' | 'str' }> = [
  { field: 'tool.egress_class', values: fc.constantFrom('INTERNAL', 'EXTERNAL', 'PUBLIC'), kind: 'enum' },
  { field: 'tool.reversibility', values: fc.constantFrom('R0', 'R1', 'R2', 'R3'), kind: 'enum' },
  { field: 'tool.id', values: fc.constantFrom('gmail.send', 'gmail.draft', 'gcal.create'), kind: 'str' },
  { field: 'args.recipient.taint', values: fc.constantFrom('TRUSTED', 'ORG', 'UNTRUSTED'), kind: 'enum' },
  { field: 'target.audience', values: fc.constantFrom('NONE', 'INTERNAL', 'CLIENT', 'EXTERNAL', 'PUBLIC'), kind: 'enum' },
  { field: 'risk.score', values: fc.integer({ min: 0, max: 100 }), kind: 'num' },
  { field: 'effect.monetary_value.amount', values: fc.integer({ min: 0, max: 50_000 }), kind: 'num' },
  { field: 'data.labels', values: fc.constantFrom('PII', 'PHI', 'SECRET', 'CONFIDENTIAL'), kind: 'list' },
];

function leafArb(): fc.Arbitrary<Condition> {
  return fc.integer({ min: 0, max: FIELD_GEN.length - 1 }).chain((i) => {
    const f = FIELD_GEN[i]!;
    const preds: Array<fc.Arbitrary<Condition>> = [fc.boolean().map((b) => ({ field: f.field, pred: { op: 'exists' as const, value: b } }))];
    if (f.kind === 'num') preds.push(fc.tuple(fc.constantFrom('gt' as const, 'gte' as const, 'lt' as const, 'lte' as const), f.values as fc.Arbitrary<number>).map(([op, v]) => ({ field: f.field, pred: { op, value: v } })));
    else if (f.kind === 'list') preds.push((f.values as fc.Arbitrary<string>).map((v) => ({ field: f.field, pred: { op: 'contains' as const, value: v } })));
    else {
      const v = f.values as fc.Arbitrary<string>;
      preds.push(v.map((x) => ({ field: f.field, pred: { op: 'eq' as const, value: x } })));
      preds.push(v.map((x) => ({ field: f.field, pred: { op: 'not' as const, value: x } })));
      preds.push(fc.uniqueArray(v, { minLength: 1, maxLength: 3 }).map((xs) => ({ field: f.field, pred: { op: 'in' as const, values: xs } })));
      preds.push(fc.uniqueArray(v, { minLength: 1, maxLength: 3 }).map((xs) => ({ field: f.field, pred: { op: 'not_in' as const, values: xs } })));
    }
    return fc.oneof(...preds);
  });
}

const condArb: fc.Arbitrary<Condition> = fc.letrec<{ cond: Condition }>((tie) => ({
  cond: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    leafArb(),
    fc.array(tie('cond'), { minLength: 1, maxLength: 3 }).map((all) => ({ all })),
    fc.array(tie('cond'), { minLength: 1, maxLength: 3 }).map((any) => ({ any })),
    tie('cond').map((c) => ({ not: c })),
  ),
})).cond;

/** Inputs where any field may be missing or null — the case the two sides most easily disagree on. */
const inputArb = fc
  .record({
    egress: fc.option(fc.constantFrom('INTERNAL', 'EXTERNAL', 'PUBLIC'), { nil: undefined }),
    rev: fc.constantFrom('R0', 'R1', 'R2', 'R3'),
    id: fc.constantFrom('gmail.send', 'gmail.draft', 'gcal.create'),
    rtaint: fc.option(fc.constantFrom('TRUSTED', 'ORG', 'UNTRUSTED'), { nil: undefined }),
    audience: fc.constantFrom('NONE', 'INTERNAL', 'CLIENT', 'EXTERNAL', 'PUBLIC'),
    score: fc.integer({ min: 0, max: 100 }),
    amount: fc.option(fc.integer({ min: 0, max: 50_000 }), { nil: undefined }),
    labels: fc.option(fc.subarray(['PII', 'PHI', 'SECRET', 'CONFIDENTIAL']), { nil: undefined }),
  })
  .map((r) => {
    const i = input() as unknown as Record<string, Record<string, unknown>>;
    const tool = { ...i['tool'], reversibility: r.rev, id: r.id } as Record<string, unknown>;
    if (r.egress !== undefined) tool['egress_class'] = r.egress;
    else delete tool['egress_class'];
    return {
      ...i,
      tool,
      args: { taint: 'TRUSTED', recipient: r.rtaint === undefined ? { count: 1, domains: [] } : { taint: r.rtaint, count: 1, domains: [] } },
      target: { audience: r.audience },
      risk: { score: r.score, tier: 'LOW' },
      effect: { recipients: 1, external_recipients: 0, records: 1, fidelity: 'DERIVED', ...(r.amount !== undefined ? { monetary_value: { amount: r.amount, currency: 'EUR' } } : {}) },
      data: r.labels === undefined ? { sensitivity: 0 } : { sensitivity: 0, labels: r.labels },
    } as unknown as PolicyInput;
  });

describe('differential (BLOCKING): the compiled Rego agrees with the reference evaluator on OPA', () => {
  beforeAll(async () => {
    expect(await opa.healthy(), `OPA must be reachable at ${OPA} (docker run -p 8182:8181 ${OPA_IMAGE} run --server)`).toBe(true);
  });

  it('random policies × random inputs (missing and null fields included)', async () => {
    let n = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(condArb, { minLength: 1, maxLength: 4 }), fc.array(inputArb, { minLength: 1, maxLength: 6 }), async (conds, inputs) => {
        const policies: Array<{ policy: Policy; version: number }> = conds.map((when, i) => ({ policy: { id: `r-${i}`, description: 'random', severity: 'normal', when, then: { decision: 'ALLOW' } }, version: i + 1 }));
        const pkg = `vega.diff.p${++n}`;
        await opa.putPolicy(`diff-${n}`, compileModule(pkg, policies));
        try {
          for (const i of inputs) {
            const ours = evaluatePolicies(policies, i).map((m) => m.id);
            const theirs = (await opa.matches(pkg, i)).map((m) => m.id);
            expect(theirs, JSON.stringify({ conds, input: i })).toEqual(ours);
          }
        } finally {
          await opa.deletePolicy(`diff-${n}`);
        }
      }),
      { numRuns: Number(process.env['DIFF_RUNS'] ?? 150) },
    );
  }, 180_000);

  it('the presets and the vertical pack answer identically on both sides', async () => {
    const sets = [...PRESET_MODES.map((m) => ({ pkg: `vega.dp.${m}`, policies: presetPolicies(m) })), { pkg: 'vega.dp.pack', policies: parsePolicyYaml(goldensSource()).map((policy) => ({ policy, version: 1 })) }];
    for (const [i, s] of sets.entries()) await opa.putPolicy(`dp-${i}`, compileModule(s.pkg, s.policies));
    await fc.assert(
      fc.asyncProperty(inputArb, async (i) => {
        for (const s of sets) expect((await opa.matches(s.pkg, i)).map((m) => m.id)).toEqual(evaluatePolicies(s.policies, i).map((m) => m.id));
      }),
      { numRuns: 200 },
    );
    for (const [i] of sets.entries()) await opa.deletePolicy(`dp-${i}`);
  }, 120_000);
});

function goldensSource(): string {
  return readFileSync(join(here, '..', 'src', 'presets.ts'), 'utf8').split('PROFESSIONAL_SERVICES_PACK = `')[1]!.split('`;')[0]!;
}

describe('signed bundles, verified by OPA', () => {
  it('a signed bundle loads; the same bundle with one byte changed is refused', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const key = signingKeyFromPem(privateKey, 'vega');
    const b = buildBundle({ roots: ['vega/presets'], revision: 'presets@v1', modules: [{ path: 'vega/presets/balanced/policy.rego', content: compileModule('vega.presets.balanced', presetPolicies('balanced')) }] }, key);
    const again = buildBundle({ roots: ['vega/presets'], revision: 'presets@v1', modules: [{ path: 'vega/presets/balanced/policy.rego', content: compileModule('vega.presets.balanced', presetPolicies('balanced')) }] }, key);
    // Deterministic content: ES256 signatures are randomized (so the tar digest is not), but the
    // signed payload — every file's hash, and the key id — is identical for identical inputs.
    const payload = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as unknown;
    expect(payload(again.signature)).toEqual(payload(b.signature));
    expect(again.files).toEqual(b.files);
    const dir = scratch('bundle-');
    writeFileSync(join(dir, 'bundle.tar.gz'), b.tarGz);
    writeFileSync(join(dir, 'pub.pem'), publicPem(key));
    const inspect = (file: string) =>
      execFileSync('docker', ['run', '--rm', '-v', `${dir}:/b`, OPA_IMAGE, 'eval', '--bundle', `/b/${file}`, '--format', 'raw', 'count(data.vega.presets.balanced.matches) >= 0'], { stdio: 'pipe' }).toString();
    expect(inspect('bundle.tar.gz').trim()).toBe('true');
    const verify = (file: string) =>
      execFileSync('docker', ['run', '--rm', '-v', `${dir}:/b`, OPA_IMAGE, 'build', '-b', `/b/${file}`, '--verification-key', '/b/pub.pem', '--verification-key-id', 'vega', '--signing-alg', 'ES256', '-o', '/tmp/out.tar.gz'], { stdio: 'pipe' });
    expect(() => verify('bundle.tar.gz')).not.toThrow();
    const raw = execFileSync('gzip', ['-dc', join(dir, 'bundle.tar.gz')]);
    const i = raw.indexOf('reads-automatic');
    raw.write('READS', i);
    writeFileSync(join(dir, 'tampered.tar'), raw);
    execFileSync('gzip', ['-f', join(dir, 'tampered.tar')]);
    expect(() => verify('tampered.tar.gz')).toThrow(/digest mismatch|verif/);
  });
});

describe('the model router (C4)', () => {
  it('untrusted content only ever reaches the quarantined extraction model', () => {
    expect(routeModel({ purpose: 'extractor', plan: 'enterprise', untrusted: true }).model).toBe('claude-haiku-4-5-20251001');
    expect(() => routeModel({ purpose: 'planner', plan: 'enterprise', untrusted: true })).toThrow(RoutingRefused);
  });
  it('HIGH/CRITICAL risk overrides plan economics; self-serve plans plan economically otherwise', () => {
    expect(routeModel({ purpose: 'planner', plan: 'pro', untrusted: false, riskTier: 'HIGH' }).model).toBe('claude-opus-5');
    expect(routeModel({ purpose: 'planner', plan: 'pro', untrusted: false }).model).toBe('claude-sonnet-5');
    // "Existential below Teams": business plans economically too; Teams and up get the best model.
    expect(routeModel({ purpose: 'planner', plan: 'business', untrusted: false }).model).toBe('claude-sonnet-5');
    expect(routeModel({ purpose: 'planner', plan: 'teams', untrusted: false }).model).toBe('claude-opus-5');
  });
  it('residency is enforced; a budget breach queues instead of spending', () => {
    expect(routeModel({ purpose: 'intent', plan: 'business', untrusted: false, residency: 'eu' }).region).toBe('eu');
    expect(() => routeModel({ purpose: 'intent', plan: 'business', untrusted: false, residency: 'cn' })).toThrow(RoutingRefused);
    expect(routeModel({ purpose: 'planner', plan: 'pro', untrusted: false, budget: { spentCents: 3000, limitCents: 3000 } })).toMatchObject({ queue: true, model: 'claude-sonnet-5' });
  });
});
