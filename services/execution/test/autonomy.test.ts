import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { capture } from '@vega/autonomy';
import { ContactLedger, LockManager, union, WriteReconciler } from '@vega/contention';
import { launchRegistry } from '@vega/connectors';
import { FakeProviders } from '@vega/connector-testing';
import { DbosOrchestrator, type Hooks, type PolicyDecision, type StepContext } from '@vega/orchestration';
import type { RunStatus } from '@vega/contracts';
import { AutonomyEngine } from '../src/autonomy/engine.js';
import { ContentionGuard } from '../src/contention/guard.js';
import { RUN_WORKFLOW, runWorkflow, TOPICS, type PendingAction } from '../src/executor/index.js';
import { ROLLBACK_WORKFLOW, rollbackWorkflow } from '../src/reversibility/index.js';
import { connect, dbosUrl, executorKit, objectiveFor, ownerQuery, plannedRun, seedTenant, setAgentSpec, waitFor, type ExecutorKit, type Tenant } from './fixtures.js';

/**
 * MODULE 10 AT THE EXECUTOR (docs/module10.md §7, §10, §19) against real Postgres, the real DBOS
 * engine and the provider fakes. Autonomy is enforced where the work happens: these tests change
 * a tier in the database and watch the very next consequential call of a RUN IN FLIGHT obey it —
 * there is no UI in this file at all. ★ = a §19 BLOCKING suite.
 */

vi.setConfig({ testTimeout: 60_000 });

const SYSTEM_DB = 'vega_dbos_autonomy_test';
const providers = new FakeProviders();
const log = { warn: () => undefined, info: () => undefined, error: () => undefined };
const engine = new AutonomyEngine(log);
const store = engine.store;
const guard = new ContentionGuard({ locks: new LockManager(), ledger: new ContactLedger(), reconciler: new WriteReconciler({ tags: union }), log });
let decide: (ctx: StepContext) => Promise<PolicyDecision> = async () => ({ decision: 'ALLOW', riskTier: 'LOW' });
let kit: ExecutorKit;
let orchestrator: DbosOrchestrator;
let t: Tenant;
let bindings: Record<string, string>;

const ALL_TOOLS = launchRegistry().records().map((r) => r.toolId);
const create = (summary: string, attendee = 'guest@partner.example') => `call gcal.create({ summary: "${summary}", start: "2026-11-02T09:00:00Z", end: "2026-11-02T09:30:00Z", attendees: ["${attendee}"] })`;
const live = () => providers.google.events(t.email).filter((e) => e.status !== 'cancelled');

beforeAll(async () => {
  await ownerQuery(`DROP DATABASE IF EXISTS ${SYSTEM_DB} WITH (FORCE)`);
  kit = await executorKit(providers.fetch, {
    policy: (ctx) => decide(ctx),
    reversibility: { notifier: { notify: async () => undefined }, pushSecret: 'test-push-secret' },
    hooks: (h: Hooks): Hooks => ({ ...h, autonomy: (c, d, x) => engine.fold(c, d, x) }),
    contacts: { cooldown: (tenantId, recipients, runId) => guard.cooldown(tenantId, recipients, runId) },
  });
  kit.deps.autonomy = engine;
  kit.deps.contention = guard;
  orchestrator = new DbosOrchestrator({ appName: 'vega-autonomy-test', systemDatabaseUrl: dbosUrl(SYSTEM_DB), logLevel: 'error' });
  orchestrator.register(RUN_WORKFLOW, runWorkflow(kit.deps));
  orchestrator.register(ROLLBACK_WORKFLOW, rollbackWorkflow(kit.engine!));
  await orchestrator.launch();
  t = await seedTenant();
  await setAgentSpec(t, 1, { allowedTools: ALL_TOOLS });
  bindings = {
    gmail: await connect(t, 'gmail', (s) => providers.grant('google', t.email, s)),
    gcal: await connect(t, 'gcal', (s) => providers.grant('google', t.email, s)),
  };
}, 60_000);

afterAll(async () => {
  await orchestrator?.shutdown();
});

const until = (runId: string, want: RunStatus[], ms = 30_000) =>
  waitFor(async () => {
    const v = await kit.store.view(t.tenantId, runId);
    return v && want.includes(v.status) ? v : null;
  }, ms, `run ${runId} to reach ${want.join('|')}`).catch(async (e: Error) => {
    const v = await kit.store.view(t.tenantId, runId);
    throw new Error(`${e.message} (it is ${v?.status}${v?.statusReason ? `: ${v.statusReason}` : ''})`);
  });
const start = (runId: string) => orchestrator.start(RUN_WORKFLOW, runId, { tenantId: t.tenantId, runId });
const setTier = (tier: 'SHADOW' | 'SUPERVISED' | 'SAMPLED' | 'AUTONOMOUS' | 'SUSPENDED', extra: { sampleRate?: number; certificationId?: string } = {}, toolId = 'gcal.create', tenant = t) =>
  store.transition({ tenantId: tenant.tenantId, workflowKey: tenant.agentId, actionType: toolId, fromTier: 'SHADOW', toTier: tier, direction: 'PROMOTE', trigger: 'manual', evidence: {}, sampleRate: extra.sampleRate ?? null, certificationId: extra.certificationId ?? null });
const tierOf = async (toolId = 'gcal.create') => (await store.get(t.tenantId, t.agentId, toolId))?.tier ?? null;
const nodeErr = async (runId: string, toolId = 'gcal.create') => (await ownerQuery<{ error_json: { code: string; message: string } | null }>(`SELECT error_json FROM task_nodes WHERE run_id = $1 AND tool_id = $2 ORDER BY step_index`, [runId, toolId]))[0]?.error_json;
async function fresh(): Promise<Tenant> {
  // Each test gets its own pair on the ladder: tiers are independent per (workflow × action).
  const nt = await seedTenant();
  await setAgentSpec(nt, 1, { allowedTools: ALL_TOOLS });
  bindings = {
    gmail: await connect(nt, 'gmail', (s) => providers.grant('google', nt.email, s)),
    gcal: await connect(nt, 'gcal', (s) => providers.grant('google', nt.email, s)),
  };
  t = nt;
  return nt;
}

describe('★ the tier is enforced at the executor (§7)', () => {
  it('an untiered pair is untouched: autonomy blocks nothing until someone puts it on the ladder (§1)', async () => {
    await fresh();
    const { runId } = await plannedRun(kit, t, `${create('Untiered')}\nemit "ok"`, { bindings });
    await start(runId);
    await until(runId, ['COMPLETED']);
    expect(live().some((e) => e.summary === 'Untiered')).toBe(true);
    expect(await tierOf()).toBeNull(); // looking at a pair never puts it on the ladder
  });

  it('SUPERVISED: policy said ALLOW, but a person approves each action; approved, it runs', async () => {
    await fresh();
    await setTier('SUPERVISED');
    const { runId } = await plannedRun(kit, t, `${create('Supervised')}\nemit "ok"`, { bindings });
    await start(runId);
    const v = await until(runId, ['AWAITING_APPROVAL', 'COMPLETED']);
    expect(v.status).toBe('AWAITING_APPROVAL');
    const pending = v.pending as PendingAction;
    expect(pending.reason).toMatch(/^autonomy: the SUPERVISED tier for gcal\.create requires a person to approve each action/);
    expect(pending.policy!.chain!.some((c) => c.step === 'autonomy')).toBe(true);
    expect(live().some((e) => e.summary === 'Supervised')).toBe(false); // nothing happened yet
    await orchestrator.send(runId, TOPICS.decision, { key: pending.key, decision: 'approve', by: t.userId });
    await until(runId, ['COMPLETED']);
    expect(live().some((e) => e.summary === 'Supervised')).toBe(true);
  });

  it('SHADOW is enforced like SUPERVISED: it decides, a person acts', async () => {
    await fresh();
    await setTier('SHADOW');
    const { runId } = await plannedRun(kit, t, `${create('Shadow')}\nemit "ok"`, { bindings });
    await start(runId);
    expect((await until(runId, ['AWAITING_APPROVAL', 'COMPLETED'])).status).toBe('AWAITING_APPROVAL');
    expect(live().some((e) => e.summary === 'Shadow')).toBe(false);
  });

  it('★ SUSPENDED blocks outright, with a code that says why, and nothing reaches the provider', async () => {
    await fresh();
    await setTier('SUSPENDED');
    const { runId } = await plannedRun(kit, t, `${create('Suspended')}\nemit "ok"`, { bindings });
    await start(runId);
    const v = await until(runId, ['REPLANNING', 'FAILED', 'COMPLETED']);
    expect(v.status).toBe('REPLANNING');
    expect(await nodeErr(runId)).toMatchObject({ code: 'AUTONOMY_SUSPENDED', message: expect.stringMatching(/SUSPENDED.*re-certify/) });
    expect(live().some((e) => e.summary === 'Suspended')).toBe(false);
  });

  it('★ autonomy can only downgrade a disposition: AUTONOMOUS does not relax policy\'s REQUIRE_APPROVAL', async () => {
    await fresh();
    await setTier('AUTONOMOUS');
    decide = async () => ({ decision: 'REQUIRE_APPROVAL', riskTier: 'HIGH', approverRole: 'APPROVER', reason: 'policy: external invites are supervised' });
    try {
      const { runId } = await plannedRun(kit, t, `${create('Policy wins')}\nemit "ok"`, { bindings });
      await start(runId);
      const v = await until(runId, ['AWAITING_APPROVAL', 'COMPLETED']);
      expect(v.status).toBe('AWAITING_APPROVAL');
      expect((v.pending as PendingAction).reason).toMatch(/policy: external invites are supervised/);
      expect((v.pending as PendingAction).reason).not.toMatch(/autonomy:/);
    } finally {
      decide = async () => ({ decision: 'ALLOW', riskTier: 'LOW' });
    }
  });

  it('and an explicit policy DENY is final for every tier', async () => {
    await fresh();
    await setTier('AUTONOMOUS');
    decide = async () => ({ decision: 'DENY', reason: 'policy: no external invites on Fridays', riskTier: 'HIGH' });
    try {
      const { runId } = await plannedRun(kit, t, `${create('Denied')}\nemit "ok"`, { bindings });
      await start(runId);
      await until(runId, ['REPLANNING', 'FAILED']);
      expect(await nodeErr(runId)).toMatchObject({ code: 'POLICY_DENIED' });
    } finally {
      decide = async () => ({ decision: 'ALLOW', riskTier: 'LOW' });
    }
  });

  it('SAMPLED: a deterministic 1-in-N goes to a person; the rest proceed on their own', async () => {
    await fresh();
    await setTier('SAMPLED', { sampleRate: 1 }); // 1-in-1: every action is sampled
    const a = await plannedRun(kit, t, `${create('Sampled in')}\nemit "ok"`, { bindings });
    await start(a.runId);
    expect((await until(a.runId, ['AWAITING_APPROVAL', 'COMPLETED'])).status).toBe('AWAITING_APPROVAL');

    await setTier('SAMPLED', { sampleRate: 1_000_000_000 }); // effectively none are sampled
    const b = await plannedRun(kit, t, `${create('Sampled out')}\nemit "ok"`, { bindings });
    await start(b.runId);
    await until(b.runId, ['COMPLETED']);
    expect(live().some((e) => e.summary === 'Sampled out')).toBe(true);
  });

  it('★ a mid-run demotion takes effect on the very next call of a run in flight', async () => {
    await fresh();
    await setTier('AUTONOMOUS');
    const tenant = t;
    let calls = 0;
    kit.onExecute = async ({ toolId }) => {
      if (toolId !== 'gcal.create') return;
      if (++calls === 1) await engine.demote(tenant.tenantId, tenant.agentId, 'gcal.create', 'critical_error', { why: 'an operator found a bad send, mid-run' });
    };
    try {
      const { runId } = await plannedRun(kit, t, `${create('First')}\n${create('Second')}\nemit "ok"`, { bindings });
      await start(runId);
      await until(runId, ['REPLANNING', 'FAILED', 'COMPLETED', 'COMPENSATED']);
      const titles = live().map((e) => e.summary);
      expect(titles).toContain('First'); // the call already past the gate ran
      expect(titles).not.toContain('Second'); // the next one saw the new tier
      expect(await tierOf()).toBe('SUSPENDED');
      expect(await nodeErr(runId)).toBeDefined();
    } finally {
      kit.onExecute = undefined;
    }
  });

  it('★ the tier lives in the executor: a UI-only change with no state row changes nothing, a state row alone changes everything', async () => {
    // "Attempting a UI-only bypass" (§18): requesting a lighter autonomy on the objective, or any
    // API-shaped hint, cannot lift a tier — the only input the executor reads is the state row.
    await fresh();
    await setTier('SUPERVISED');
    const { runId } = await plannedRun(kit, t, `${create('Bypass')}\nemit "ok"`, { bindings, objective: objectiveFor(t, 'run it autonomously', { requestedAutonomy: 'supervised' }) });
    await start(runId);
    expect((await until(runId, ['AWAITING_APPROVAL', 'COMPLETED'])).status).toBe('AWAITING_APPROVAL');
    expect(live().some((e) => e.summary === 'Bypass')).toBe(false);
  });
});

describe('automatic demotion at the moment a trigger fires (§6)', () => {
  it('★ taint violation → SUSPENDED', async () => {
    await fresh();
    await setTier('AUTONOMOUS');
    const { runId } = await plannedRun(kit, t, `call gcal.create({ summary: "x", start: "2026-11-02T09:00:00Z", end: "2026-11-02T09:30:00Z", attendees: [trigger_payload.who] })\nemit "ok"`, { bindings, triggerPayload: { who: 'attacker@evil.example' } });
    await start(runId);
    await until(runId, ['FAILED']);
    expect(await tierOf()).toBe('SUSPENDED');
    const [tr] = await store.transitions(t.tenantId, t.agentId, 'gcal.create');
    expect(tr).toMatchObject({ direction: 'DEMOTE', trigger: 'taint_violation', actorId: null });
  });

  it('★ a connector version change since certification → SUPERVISED, and re-promotion needs a new certification', async () => {
    await fresh();
    const [decl] = await ownerQuery<{ version: number }>(`SELECT version FROM tool_declarations WHERE tool_id = 'gcal.create'`);
    const cert = (await ownerQuery<{ id: string }>(
      `INSERT INTO certifications (tenant_id, workflow_key, action_type, window_from, window_to, sample_size, agreement_rate, edit_rate, critical_errors, error_taxonomy, connector_versions, model_versions, from_tier, recommendation, report_ref, signature)
       VALUES ($1,$2,'gcal.create', now() - interval '30 days', now(), 250, 0.99, 0.01, 0, '[]', $3, '[]', 'SAMPLED', 'PROMOTE', 'sha256:r', 's') RETURNING id`,
      [t.tenantId, t.agentId, JSON.stringify({ 'gcal.create': decl!.version + 7 })],
    ))[0]!.id;
    await setTier('AUTONOMOUS', { certificationId: cert });
    const { runId } = await plannedRun(kit, t, `${create('Version')}\nemit "ok"`, { bindings });
    await start(runId);
    const v = await until(runId, ['AWAITING_APPROVAL', 'COMPLETED']);
    expect(v.status).toBe('AWAITING_APPROVAL');
    expect(await tierOf()).toBe('SUPERVISED');
    const [tr] = await store.transitions(t.tenantId, t.agentId, 'gcal.create');
    expect(tr).toMatchObject({ trigger: 'version_change', direction: 'DEMOTE', fromTier: 'AUTONOMOUS', toTier: 'SUPERVISED' });
    expect(JSON.stringify(tr!.evidenceJson)).toMatch(/changed from v/);
  });

  it('★ error rate over the rolling window → SUPERVISED', async () => {
    await fresh();
    await setTier('SAMPLED', { sampleRate: 1_000_000_000 });
    // 30 recent human decisions on this pair, 9 of them rejections (30%)
    for (let i = 0; i < 30; i++) {
      const run = (await ownerQuery<{ id: string }>(`INSERT INTO runs (tenant_id, workspace_id, agent_id, principal_user_id, trigger, objective_json, status) VALUES ($1,$2,$3,$4,'api','{"objective":"x"}','COMPLETED') RETURNING id`, [t.tenantId, t.workspaceId, t.agentId, t.userId]))[0]!.id;
      const node = (await ownerQuery<{ id: string }>(`INSERT INTO task_nodes (tenant_id, run_id, program_version, step_index, kind, tool_id, status) VALUES ($1,$2,1,0,'TOOL_CALL','gcal.create','done') RETURNING id`, [t.tenantId, run]))[0]!.id;
      const req = (await ownerQuery<{ id: string }>(`INSERT INTO approval_requests (tenant_id, run_id, node_id, approval_key, tool_id, requester, approver_role, packet_json, packet_digest, expires_at, fallback, state) VALUES ($1,$2,$3,$4,'gcal.create',$5,'APPROVER','{}','sha256:x', now() + interval '1 day','AUTO_REJECT','approved') RETURNING id`, [t.tenantId, run, node, `k${i}-${Math.random()}`, t.userId]))[0]!.id;
      await ownerQuery(`INSERT INTO approval_decisions (tenant_id, request_id, run_id, tool_id, approver_id, decision, latency_ms, evidence_opened, surface, packet_digest, packet_chars) VALUES ($1,$2,$3,'gcal.create',$4,$5,5000,true,'web','sha256:x',100)`, [t.tenantId, req, run, t.userId, i < 9 ? 'reject' : 'approve']);
    }
    const { runId } = await plannedRun(kit, t, `${create('Rate')}\nemit "ok"`, { bindings });
    await start(runId);
    expect((await until(runId, ['AWAITING_APPROVAL', 'COMPLETED'])).status).toBe('AWAITING_APPROVAL');
    const [tr] = await store.transitions(t.tenantId, t.agentId, 'gcal.create');
    expect(tr).toMatchObject({ trigger: 'error_rate', toTier: 'SUPERVISED', actorId: null });
  });

  it('★ a compensation that cannot be undone → SUSPENDED (M6 §5.8)', async () => {
    await fresh();
    await setTier('AUTONOMOUS');
    decide = async (ctx) => (ctx.toolId === 'gmail.send' ? { decision: 'DENY', failClosed: true, reason: 'engine unavailable (test)' } : { decision: 'ALLOW', riskTier: 'LOW' });
    try {
      const { runId } = await plannedRun(kit, t, `${create('Comp one')}\ncall gmail.send({ to: ["x@partner.example"], subject: "S", body: "B" })\nemit "ok"`, { bindings });
      providers.core.inject({ match: (u, m) => m === 'DELETE' && u.pathname.includes('/events/'), status: 403, times: 1 });
      await start(runId);
      await until(runId, ['COMPENSATION_FAILED', 'COMPENSATED', 'FAILED']);
      expect(await tierOf('gcal.create')).toBe('SUSPENDED');
      const [tr] = await store.transitions(t.tenantId, t.agentId, 'gcal.create');
      expect(tr).toMatchObject({ trigger: 'comp_failure', toTier: 'SUSPENDED' });
    } finally {
      decide = async () => ({ decision: 'ALLOW', riskTier: 'LOW' });
    }
  });

  it('novelty routes THAT call to a person without demoting the workflow (§6.1)', async () => {
    await fresh();
    await setTier('AUTONOMOUS');
    await store.saveNoveltyBaseline({ tenantId: t.tenantId, workflowKey: t.agentId, actionType: 'gcal.create', featureStats: capture([{ domain: 'acme.example' }, { domain: 'acme.example' }, { domain: 'acme.example' }]) as never });
    // a recipient domain never certified → a person looks at this one call
    const odd = await plannedRun(kit, t, `${create('Novel', 'stranger@competitor.example')}\nemit "ok"`, { bindings });
    await start(odd.runId);
    const v = await until(odd.runId, ['AWAITING_APPROVAL', 'COMPLETED']);
    expect(v.status).toBe('AWAITING_APPROVAL');
    expect((v.pending as PendingAction).reason).toMatch(/unlike what gcal\.create was certified on: recipient domain "competitor\.example"/);
    expect(await tierOf()).toBe('AUTONOMOUS'); // the workflow was NOT demoted
    expect(await store.transitions(t.tenantId, t.agentId, 'gcal.create')).toHaveLength(1); // only the setup transition
    // …while a familiar one on the same pair runs on its own
    const usual = await plannedRun(kit, t, `${create('Familiar', 'peter@acme.example')}\nemit "ok"`, { bindings });
    await start(usual.runId);
    await until(usual.runId, ['COMPLETED']);
    expect(live().some((e) => e.summary === 'Familiar')).toBe(true);
  });
});

describe('contention control at the executor (§10)', () => {
  it('★ ZERO duplicate outreach: a second agent inside the cooldown is blocked before anything is sent', async () => {
    await fresh();
    const a = await plannedRun(kit, t, `${create('Outreach A', 'prospect@acme.example')}\nemit "ok"`, { bindings });
    await start(a.runId);
    await until(a.runId, ['COMPLETED']);
    const sentBefore = live().length;

    const b = await plannedRun(kit, t, `${create('Outreach B', 'Prospect+qbr@Acme.example')}\nemit "ok"`, { bindings });
    await start(b.runId);
    const v = await until(b.runId, ['REPLANNING', 'FAILED', 'COMPLETED']);
    expect(v.status).toBe('REPLANNING');
    expect(live().length).toBe(sentBefore);
    expect(live().some((e) => e.summary === 'Outreach B')).toBe(false);
    // the early verification check refuses it, naming who holds the relationship
    const ver = (await ownerQuery<{ checks_json: Array<{ check: string; outcome: string; detail: string }> }>(`SELECT checks_json FROM verifications WHERE run_id = $1`, [b.runId]))[0]!;
    expect(ver.checks_json.find((c) => c.check === 'conflicts')).toMatchObject({ outcome: 'ABORT', detail: expect.stringMatching(/Cannot contact prospect@acme\.example.*another agent contacted them/) });
    // and the ledger row of the first contact names the agent and the run
    const [row] = await ownerQuery<{ by_run_id: string; relationship_type: string }>(`SELECT * FROM contact_ledger WHERE tenant_id = $1 AND external_identity = 'prospect@acme.example'`, [t.tenantId]);
    expect(row).toMatchObject({ by_run_id: a.runId, relationship_type: 'prospect' });
  });

  it('a person someone else is mid-send to is locked: the call waits its turn, not a second send', async () => {
    await fresh();
    const other = (await ownerQuery<{ id: string }>(`INSERT INTO runs (tenant_id, workspace_id, agent_id, principal_user_id, trigger, objective_json, status) VALUES ($1,$2,$3,$4,'api','{"objective":"x"}','EXECUTING') RETURNING id`, [t.tenantId, t.workspaceId, t.agentId, t.userId]))[0]!.id;
    await new LockManager().acquire({ tenantId: t.tenantId, entityKey: 'contact:busy@acme.example', mode: 'COMMUNICATION', runId: other, agentId: t.agentId, intent: 'sending the quarterly review' });
    const { runId } = await plannedRun(kit, t, `${create('Locked', 'busy@acme.example')}\nemit "ok"`, { bindings });
    await start(runId);
    expect((await until(runId, ['REPLANNING', 'FAILED', 'COMPLETED'])).status).toBe('REPLANNING');
    expect(await nodeErr(runId)).toMatchObject({ code: 'CONTENDED', message: expect.stringMatching(/being contacted by another agent right now \(sending the quarterly review\)/) });
    expect(live().some((e) => e.summary === 'Locked')).toBe(false);
  });

  it('a finished run holds nothing: its locks are released on termination (§10.1)', async () => {
    await fresh();
    const { runId } = await plannedRun(kit, t, `${create('Release', 'release@acme.example')}\nemit "ok"`, { bindings });
    await start(runId);
    await until(runId, ['COMPLETED']);
    expect(await ownerQuery(`SELECT 1 FROM entity_locks WHERE holder_run_id = $1`, [runId])).toEqual([]);
  });
});

describe('★ budget caps (P5 §12, §19 blocking)', () => {
  /** This month's spend for the tenant, as a completed run that cost `cents`. */
  const spend = (cents: number) =>
    ownerQuery(`INSERT INTO runs (tenant_id, workspace_id, agent_id, principal_user_id, trigger, objective_json, status, cost_cents) VALUES ($1,$2,$3,$4,'api','{"objective":"spent"}','COMPLETED',$5)`, [t.tenantId, t.workspaceId, t.agentId, t.userId, cents]);
  const cap = (limit: number, behavior: 'degrade' | 'queue' | 'halt') =>
    ownerQuery(`INSERT INTO budgets (tenant_id, limit_cents, breach_behavior) VALUES ($1,$2,$3) ON CONFLICT (tenant_id) DO UPDATE SET limit_cents = $2, breach_behavior = $3`, [t.tenantId, limit, behavior]);

  it('halt: a run in flight stops at its next consequential step, with a code that says why, and nothing reaches the provider', async () => {
    await fresh();
    await spend(150);
    await cap(100, 'halt');
    const { runId } = await plannedRun(kit, t, `${create('Halted')}\nemit "ok"`, { bindings });
    await start(runId);
    await until(runId, ['REPLANNING', 'FAILED', 'COMPLETED']);
    expect(await nodeErr(runId)).toMatchObject({ code: 'BUDGET_HALTED', message: expect.stringMatching(/monthly budget.*spent.*halt at the cap/) });
    expect(live().some((e) => e.summary === 'Halted')).toBe(false);
  });

  it('halt below the cap changes nothing', async () => {
    await fresh();
    await spend(40);
    await cap(100, 'halt');
    const { runId } = await plannedRun(kit, t, `${create('Under cap')}\nemit "ok"`, { bindings });
    await start(runId);
    await until(runId, ['COMPLETED']);
    expect(live().some((e) => e.summary === 'Under cap')).toBe(true);
  });

  it('queue and degrade are decided at planning; the executor does not stop a run that was already planned', async () => {
    for (const behavior of ['queue', 'degrade'] as const) {
      await fresh();
      await spend(500);
      await cap(100, behavior);
      const { runId } = await plannedRun(kit, t, `${create(`Planned ${behavior}`)}\nemit "ok"`, { bindings });
      await start(runId);
      await until(runId, ['COMPLETED']);
      expect(live().some((e) => e.summary === `Planned ${behavior}`)).toBe(true);
    }
  });

  it('a cap of zero is no cap', async () => {
    await fresh();
    await spend(9_999);
    await cap(0, 'halt');
    const { runId } = await plannedRun(kit, t, `${create('Uncapped')}\nemit "ok"`, { bindings });
    await start(runId);
    await until(runId, ['COMPLETED']);
    expect(live().some((e) => e.summary === 'Uncapped')).toBe(true);
  });
});
