import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { launchRegistry } from '@vega/connectors';
import { FakeProviders } from '@vega/connector-testing';
import { DbosOrchestrator, type PolicyDecision, type StepContext } from '@vega/orchestration';
import { compileModule, OpaClient, PatternClassifier, parsePolicyYaml, PRESET_MODES, presetPolicies, PROFESSIONAL_SERVICES_PACK, tenantPackage, type Policy } from '@vega/policy-engine';
import { scoreRisk, type RiskInput, type Weights } from '@vega/risk';
import type { RunStatus } from '@vega/contracts';
import { RUN_WORKFLOW, runWorkflow, type PendingAction } from '../src/executor/index.js';
import { PolicyEngine } from '../src/policy/index.js';
import { connect, dbosUrl, executorKit, ownerQuery, plannedRun, seedTenant, setAgentSpec, silent, waitFor, type ExecutorKit, type Tenant } from './fixtures.js';

/**
 * THE POLICY ENGINE IN THE EXECUTOR (docs/module5.md §8.1, §10, §11, §12) against a real OPA, real
 * Postgres, the real DBOS engine and the provider fakes: every step decided and recorded with its
 * reason chain; holds that release themselves, early or never; dual approval with separation of
 * duties; tenant policies; fail-closed when OPA dies mid-run (a real container, killed); risk
 * reproducible from what was stored; decision latency.
 */

vi.setConfig({ testTimeout: 40_000 });

const OPA_URL = process.env['OPA_TEST_URL'] ?? 'http://localhost:8182';
const OPA_IMAGE = process.env['OPA_IMAGE'] ?? 'mirror.gcr.io/openpolicyagent/opa:1.10.1-static';
const SYSTEM_DB = 'vega_dbos_policy_test';
const providers = new FakeProviders();
const opa = new OpaClient({ baseUrl: OPA_URL, timeoutMs: 2_000 });
const engine = new PolicyEngine({ opa, classifier: new PatternClassifier(), classifierName: 'pattern-test', log: silent, cacheTtlMs: 0 });
/** The hook delegates here, so a test can swap the engine (a dying OPA) or a stub decision. */
let decide: (ctx: StepContext) => Promise<PolicyDecision> = (ctx) => engine.decide(ctx);
let kit: ExecutorKit;
let orchestrator: DbosOrchestrator;
let t: Tenant;
let bindings: Record<string, string>;

const ALL_TOOLS = launchRegistry().records().map((r) => r.toolId);

async function loadPresets(client: OpaClient) {
  for (const mode of PRESET_MODES) await client.putPolicy(`presets-${mode}`, compileModule(`vega.presets.${mode}`, presetPolicies(mode)));
}

/** Activates `policies` as the tenant's bundle: the DB row (what the engine requires) + OPA. */
async function activate(tenant: Tenant, policies: Array<{ policy: Policy; version: number }>, opts: { loadIntoOpa?: boolean } = {}) {
  const v = (await ownerQuery<{ v: number }>(`SELECT coalesce(max(version), 0) + 1 AS v FROM policy_bundles WHERE tenant_id = $1`, [tenant.tenantId]))[0]!.v;
  await ownerQuery(`UPDATE policy_bundles SET superseded_at = now() WHERE tenant_id = $1 AND activated_at IS NOT NULL AND superseded_at IS NULL`, [tenant.tenantId]);
  const rego = compileModule(tenantPackage(tenant.tenantId), policies);
  await ownerQuery(
    `INSERT INTO policy_bundles (tenant_id, version, policy_ids, policy_versions, rego, revision, bundle_ref, digest, signature, created_by, activated_at, activated_by)
     VALUES ($1, $2, '{}', $3, $4, $5, 'test', 'sha256:test', 'test', $6, now(), $6)`,
    [tenant.tenantId, v, JSON.stringify(policies.map((p) => ({ key: p.policy.id, version: p.version }))), rego, `t@v${v}`, tenant.userId],
  );
  if (opts.loadIntoOpa !== false) await opa.putPolicy(`tenant-${tenant.tenantId}`, rego);
}

beforeAll(async () => {
  expect(await opa.healthy(), `OPA must be reachable at ${OPA_URL}`).toBe(true);
  await loadPresets(opa);
  await ownerQuery(`DROP DATABASE IF EXISTS ${SYSTEM_DB} WITH (FORCE)`);
  kit = await executorKit(providers.fetch, { policy: (ctx) => decide(ctx) });
  orchestrator = new DbosOrchestrator({ appName: 'vega-policy-test', systemDatabaseUrl: dbosUrl(SYSTEM_DB), logLevel: 'error' });
  orchestrator.register(RUN_WORKFLOW, runWorkflow(kit.deps));
  await orchestrator.launch();
  t = await seedTenant();
  await setAgentSpec(t, 1, { allowedTools: ALL_TOOLS });
  bindings = { gmail: await connect(t, 'gmail', (s) => providers.grant('google', t.email, s)) };
}, 60_000);

afterAll(async () => {
  await orchestrator?.shutdown();
  await opa.deletePolicy(`tenant-${t?.tenantId}`).catch(() => undefined);
});

const view = async (runId: string, tenant = t) => (await kit.store.view(tenant.tenantId, runId))!;
const until = (runId: string, want: RunStatus[], tenant = t, ms = 30_000) =>
  waitFor(async () => {
    const v = await kit.store.view(tenant.tenantId, runId);
    return v && want.includes(v.status) ? v : null;
  }, ms, `run ${runId} to reach ${want.join('|')}`);
const start = (runId: string, tenant = t) => orchestrator.start(RUN_WORKFLOW, runId, { tenantId: tenant.tenantId, runId });
const sentTo = (addr: string) => providers.google.sent.filter((m) => JSON.stringify(m).includes(addr)).length;
const evaluations = (runId: string) =>
  ownerQuery<{ tool_id: string; decision: string; policy_key: string; preset: string; reason_json: Array<{ step: string; id?: string; citation?: string; detail: string }>; risk_evaluation_id: string | null; fail_closed: boolean; hold_window_ms: number | null; approver_role: string | null; input_json: Record<string, unknown> }>(
    `SELECT * FROM policy_evaluations WHERE run_id = $1 ORDER BY evaluated_at`,
    [runId],
  );
const send = (to: string, body: string) => `call gmail.send({ to: ["${to}"], subject: "Update", body: "${body}" })\nemit "sent"`;

describe('every step is decided and recorded (§12: a persisted decision and a reason chain)', () => {
  it('reads and internal undoable writes run under Balanced; each evaluation is stored with its chain and risk', async () => {
    const { runId } = await plannedRun(kit, t, `let x = call gmail.search({ query: "policy-probe" })\ncall gmail.draft({ to: ["colleague@${t.domain}"], subject: "Notes", body: "Draft for later" })\nemit "ok"`, { bindings });
    await start(runId);
    await until(runId, ['COMPLETED']);
    const evs = await evaluations(runId);
    expect(evs.map((e) => [e.tool_id, e.decision])).toEqual([
      ['gmail.search', 'ALLOW'],
      ['gmail.draft', 'ALLOW'],
    ]);
    for (const e of evs) {
      expect(e.preset).toBe('balanced');
      expect(e.risk_evaluation_id).toBeTruthy();
      expect(e.reason_json[0]!.step).toBe('risk');
      expect(e.reason_json.at(-1)!.step).toBe('autonomy');
    }
    expect(evs[1]!.reason_json.some((s) => s.id === 'internal-undoable-automatic')).toBe(true);
    const [risk] = await ownerQuery<{ weights_version: number; tier: string }>(`SELECT weights_version, tier FROM risk_evaluations WHERE id = $1`, [evs[1]!.risk_evaluation_id]);
    expect(risk).toMatchObject({ weights_version: 1 });
  });
});

describe('ALLOW_WITH_HOLD: a durable, revocable window', () => {
  it('an external send is held (nothing sent); released early, it runs once', async () => {
    const to = 'client-release@partner.example';
    const { runId } = await plannedRun(kit, t, send(to, 'Following up on our call.'), { bindings });
    await start(runId);
    const held = await until(runId, ['HELD']);
    const pending = held.pending as PendingAction;
    expect(pending).toMatchObject({ kind: 'hold', toolId: 'gmail.send', holdWindowMs: 120_000 });
    expect(Date.parse(pending.releaseAt!) - Date.parse(pending.heldAt!)).toBe(120_000);
    expect(pending.policy?.chain?.some((s) => s.id === 'external-send-hold')).toBe(true);
    expect(sentTo(to)).toBe(0);
    await orchestrator.send(runId, 'resume', { action: 'release', by: t.userId });
    await until(runId, ['COMPLETED']);
    expect(sentTo(to)).toBe(1);
    const cp = await ownerQuery<{ cp: { released?: string[] } }>(`SELECT checkpoint_json AS cp FROM runs WHERE id = $1`, [runId]);
    expect(cp[0]!.cp.released).toEqual([pending.key]);
  });

  it('revoked inside the window: cancelled, and the message never leaves', async () => {
    const to = 'client-revoke@partner.example';
    const { runId } = await plannedRun(kit, t, send(to, 'Second thoughts.'), { bindings });
    await start(runId);
    await until(runId, ['HELD']);
    await orchestrator.send(runId, 'resume', { action: 'revoke', by: t.userId });
    const done = await until(runId, ['CANCELLED']);
    expect(done.statusReason).toContain('revoked during its hold window');
    expect(sentTo(to)).toBe(0);
    const node = (await kit.store.nodes(t.tenantId, runId)).find((n) => n.toolId === 'gmail.send');
    expect(node).toMatchObject({ status: 'skipped' });
  });

  it('left alone, the window passes and the action runs by itself', async () => {
    const to = `colleague-auto@${t.domain}`;
    decide = async (ctx) => ({ ...(await engine.decide(ctx)), decision: 'ALLOW_WITH_HOLD', holdWindowMs: 1_500 });
    try {
      const { runId } = await plannedRun(kit, t, send(to, 'Auto-release'), { bindings });
      await start(runId);
      await until(runId, ['HELD']);
      expect(sentTo(to)).toBe(0);
      await until(runId, ['COMPLETED'], t, 15_000);
      expect(sentTo(to)).toBe(1);
    } finally {
      decide = (ctx) => engine.decide(ctx);
    }
  });
});

describe('REQUIRE_DUAL_APPROVAL with separation of duties (hard gate: a RESTRICTED resource)', () => {
  it('needs two DISTINCT approvers, neither of them the requester', async () => {
    const admins = await Promise.all(
      ['a1', 'a2'].map(async (n) => (await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, role, status) VALUES ($1, $2, $3, 'ADMIN', 'active') RETURNING id`, [t.tenantId, `${n}@${t.domain}`, n]))[0]!.id),
    );
    const to = `colleague-dual@${t.domain}`;
    const { runId } = await plannedRun(kit, t, send(to, 'Strictly confidential. Do not forward.'), { bindings });
    await start(runId);
    const waiting = await until(runId, ['AWAITING_APPROVAL']);
    const pending = waiting.pending as PendingAction;
    expect(pending).toMatchObject({ kind: 'approval', approvalsRequired: 2, approvedBy: [] });
    expect(pending.policy).toMatchObject({ decision: 'REQUIRE_DUAL_APPROVAL', approverRole: 'ADMIN', separationOfDuties: true });
    expect(pending.policy?.chain?.some((s) => s.step === 'gate' && s.id === 'RESTRICTED_RESOURCE')).toBe(true);

    const approve = (by: string) => orchestrator.send(runId, 'decision', { key: pending.key, decision: 'approve', by });
    await approve(t.userId); // the requester: ignored under separation of duties
    await approve(admins[0]!);
    await waitFor(async () => ((await view(runId)).pending as PendingAction | null)?.approvedBy?.length === 1 || null, 10_000, 'first approval recorded');
    expect(((await view(runId)).pending as PendingAction).approvedBy).toEqual([admins[0]]);
    await approve(admins[0]!); // the same approver twice: ignored
    await new Promise((r) => setTimeout(r, 600));
    expect((await view(runId)).status).toBe('AWAITING_APPROVAL');
    expect(sentTo(to)).toBe(0);
    await approve(admins[1]!);
    // Approved — and a matched policy's hold window still applies after approval (Balanced holds
    // anything sent through an external channel for 2 minutes): revocable until it runs.
    const held = await until(runId, ['HELD']);
    expect(held.pending as PendingAction).toMatchObject({ kind: 'hold', holdWindowMs: 120_000 });
    expect(sentTo(to)).toBe(0);
    await orchestrator.send(runId, 'resume', { action: 'release', by: admins[1] });
    await until(runId, ['COMPLETED']);
    expect(sentTo(to)).toBe(1);
  });
});

describe('tenant policies (a signed bundle, here loaded directly into OPA)', () => {
  it('a tenant DENY is decided, cited in the chain, published, and the run replans around it', async () => {
    const tenant = await seedTenant();
    await setAgentSpec(tenant, 1, { allowedTools: ALL_TOOLS });
    const b = { gmail: await connect(tenant, 'gmail', (s) => providers.grant('google', tenant.email, s)) };
    const [policy] = parsePolicyYaml(`
- id: no-contact-with-rivals
  description: Never write to a competitor
  citation: internal-comp-007
  severity: critical
  when: { args.recipient.domains: { contains: rival.example } }
  then: { decision: DENY, reason: "Competitors are never contacted from this tenant" }
`);
    await activate(tenant, [{ policy: policy!, version: 3 }]);
    try {
      const { runId } = await plannedRun(kit, tenant, send('ceo@rival.example', 'Hello'), { bindings: b });
      await start(runId, tenant);
      await until(runId, ['REPLANNING', 'FAILED'], tenant);
      expect(sentTo('ceo@rival.example')).toBe(0);
      const [ev] = await evaluations(runId);
      expect(ev).toMatchObject({ decision: 'DENY', policy_key: 'no-contact-with-rivals' });
      expect(ev!.reason_json.find((s) => s.id === 'no-contact-with-rivals')).toMatchObject({ citation: 'internal-comp-007' });
      const events = await ownerQuery<{ payload: { reason: string } }>(`SELECT payload FROM platform_events WHERE tenant_id = $1 AND kind = 'policy.denied_action'`, [tenant.tenantId]);
      expect(events[0]!.payload.reason).toContain('Competitors are never contacted');
    } finally {
      await opa.deletePolicy(`tenant-${tenant.tenantId}`);
    }
  });

  it('the professional-services pack: an SSN to a non-client needs approval (GDPR), and only the digest is stored', async () => {
    const tenant = await seedTenant();
    await setAgentSpec(tenant, 1, { allowedTools: ALL_TOOLS });
    const b = { gmail: await connect(tenant, 'gmail', (s) => providers.grant('google', tenant.email, s)) };
    await activate(tenant, parsePolicyYaml(PROFESSIONAL_SERVICES_PACK).map((policy) => ({ policy, version: 1 })));
    try {
      const { runId } = await plannedRun(kit, tenant, send('stranger@partner.example', 'Her SSN is 536-22-8415 as requested'), { bindings: b });
      await start(runId, tenant);
      const waiting = await until(runId, ['AWAITING_APPROVAL'], tenant);
      const pending = waiting.pending as PendingAction;
      expect(pending.policy?.chain?.find((s) => s.id === 'personal-data-to-non-clients')).toMatchObject({ citation: 'GDPR Art. 5(1)(f)' });
      const [ev] = await evaluations(runId);
      expect((ev!.input_json['data'] as { labels: string[] }).labels).toContain('PII');
      const cls = await ownerQuery<{ entities: unknown; content_digest: string }>(`SELECT entities, content_digest FROM classifications WHERE tenant_id = $1`, [tenant.tenantId]);
      expect(cls.length).toBe(1);
      expect(JSON.stringify(cls)).not.toContain('536-22-8415');
      expect(cls[0]!.content_digest).toMatch(/^sha256:/);
    } finally {
      await opa.deletePolicy(`tenant-${tenant.tenantId}`);
    }
  });
});

describe('FAIL CLOSED (§10, BLOCKING): the engine never fails open', () => {
  it('chaos: OPA is killed mid-run — the next action is DENIED, recorded, alerted, and never happens', async () => {
    const name = `vega-opa-chaos-${Date.now()}`;
    execFileSync('docker', ['run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::8181', OPA_IMAGE, 'run', '--server', '--addr', '0.0.0.0:8181'], { stdio: 'pipe' });
    const port = execFileSync('docker', ['port', name, '8181/tcp']).toString().trim().split(':').pop();
    const doomed = new OpaClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 500 });
    await waitFor(async () => (await doomed.healthy()) || null, 20_000, 'chaos OPA up');
    await loadPresets(doomed);
    const alerts: string[] = [];
    const chaosEngine = new PolicyEngine({ opa: doomed, classifier: new PatternClassifier(), classifierName: 'pattern-test', log: silent, cacheTtlMs: 0, alerter: { alert: async (a) => void alerts.push(a.kind) } });
    decide = (ctx) => chaosEngine.decide(ctx);
    const to = `colleague-chaos@${t.domain}`;
    kit.onExecute = (i) => {
      // The read has been allowed and is being executed: now OPA dies.
      if (i.toolId === 'gmail.search') execFileSync('docker', ['kill', name], { stdio: 'pipe' });
    };
    try {
      const { runId } = await plannedRun(kit, t, `let x = call gmail.search({ query: "chaos" })\n${send(to, 'After the outage')}`, { bindings });
      await start(runId);
      const done = await until(runId, ['FAILED']);
      expect(done.statusReason).toMatch(/could not decide.*fail closed/);
      expect(sentTo(to)).toBe(0);
      const evs = await evaluations(runId);
      expect(evs.map((e) => [e.tool_id, e.decision, e.fail_closed])).toEqual([
        ['gmail.search', 'ALLOW', false],
        ['gmail.send', 'DENY', true],
      ]);
      const events = await ownerQuery(`SELECT 1 FROM platform_events WHERE kind = 'policy.unavailable' AND payload->>'runId' = $1`, [runId]);
      expect(events.length).toBe(1);
      expect(alerts).toEqual(['policy.unavailable']);
      const node = (await kit.store.nodes(t.tenantId, runId)).find((n) => n.toolId === 'gmail.send');
      expect(node).toMatchObject({ status: 'failed', error: expect.objectContaining({ code: 'POLICY_UNAVAILABLE' }) as unknown });
    } finally {
      kit.onExecute = undefined;
      decide = (ctx) => engine.decide(ctx);
      execFileSync('docker', ['rm', '-f', name], { stdio: 'pipe' });
    }
  }, 60_000);

  it('an activated bundle that OPA has not loaded is an outage, not "no tenant policies"', async () => {
    const tenant = await seedTenant();
    await setAgentSpec(tenant, 1, { allowedTools: ALL_TOOLS });
    const b = { gmail: await connect(tenant, 'gmail', (s) => providers.grant('google', tenant.email, s)) };
    await activate(tenant, [], { loadIntoOpa: false });
    const { runId } = await plannedRun(kit, tenant, `let x = call gmail.search({ query: "x" })\nemit count(x.messages)`, { bindings: b });
    await start(runId, tenant);
    const done = await until(runId, ['FAILED'], tenant);
    expect(done.statusReason).toContain('is not loaded');
  });

  it('a policy hook that throws stops the call before it happens — there is no path around the hook', async () => {
    decide = async () => {
      throw new Error('boom');
    };
    const to = `colleague-throw@${t.domain}`;
    try {
      const { runId } = await plannedRun(kit, t, send(to, 'x'), { bindings });
      await start(runId);
      await until(runId, ['FAILED']);
      expect(sentTo(to)).toBe(0);
    } finally {
      decide = (ctx) => engine.decide(ctx);
    }
  });
});

describe('risk is reproducible from what was stored (§5.2, BLOCKING)', () => {
  it('replaying every stored evaluation with its RECORDED weights version yields the identical score', async () => {
    const rows = await ownerQuery<{ score: number; tier: string; weights_version: number; input_json: RiskInput; factors_json: unknown; hard_gates: string[] }>(`SELECT * FROM risk_evaluations WHERE tenant_id = $1`, [t.tenantId]);
    expect(rows.length).toBeGreaterThan(5);
    const weights = new Map<number, Weights>();
    for (const w of await ownerQuery<{ version: number; weights: Omit<Weights, 'version' | 'boundaries'>; boundaries: Weights['boundaries'] }>(`SELECT * FROM risk_weights`)) {
      weights.set(w.version, { version: w.version, ...w.weights, boundaries: w.boundaries });
    }
    for (const r of rows) {
      const again = scoreRisk(r.input_json, weights.get(r.weights_version)!);
      expect({ score: again.score, tier: again.tier, factors: again.factors, gates: again.hardGates }).toEqual({ score: r.score, tier: r.tier, factors: r.factors_json, gates: r.hard_gates });
    }
  });
});

describe('decision latency (§11: p99 < 50 ms)', () => {
  it('300 decisions on a warm engine — classify (cached) + score + OPA + combine + record', async () => {
    const decl = launchRegistry().records().find((r) => r.toolId === 'gmail.send')!;
    const [run] = await ownerQuery<{ id: string }>(`SELECT id FROM runs WHERE tenant_id = $1 LIMIT 1`, [t.tenantId]);
    const [node] = await ownerQuery<{ id: string }>(`SELECT id FROM task_nodes WHERE run_id = $1 LIMIT 1`, [run!.id]);
    const ctx: StepContext = {
      tenantId: t.tenantId,
      runId: run!.id,
      programVersion: 1,
      nodeId: 'n1',
      callSeq: 1,
      nodeRowId: node!.id,
      trigger: 'test',
      toolId: 'gmail.send',
      tool: decl,
      args: { to: ['someone@partner.example'], subject: 'Latency', body: 'The same body every time, so classification is a cache hit.' },
      argTaint: 'TRUSTED',
      argTaints: [{ path: 'to[0]', taint: 'TRUSTED', dataTaint: 'TRUSTED', sourceIds: [] }],
      principalUserId: t.userId,
      agentId: t.agentId,
      agentVersion: 1,
      workspaceId: t.workspaceId,
      runCostCents: 0,
      connectorId: bindings['gmail']!,
      gate: { decision: 'PROCEED' },
    };
    const warm = new PolicyEngine({ opa, classifier: new PatternClassifier(), classifierName: 'pattern-test', log: silent });
    for (let i = 0; i < 20; i++) await warm.decide(ctx);
    const times: number[] = [];
    for (let i = 0; i < 300; i++) {
      const t0 = performance.now();
      const d = await warm.decide(ctx);
      times.push(performance.now() - t0);
      expect(d.failClosed).toBeUndefined();
    }
    times.sort((a, b) => a - b);
    const p50 = times[149]!;
    const p99 = times[296]!;
    console.info(`policy decision latency: p50 ${p50.toFixed(1)} ms, p99 ${p99.toFixed(1)} ms`);
    expect(p99).toBeLessThan(50);
  }, 60_000);
});
