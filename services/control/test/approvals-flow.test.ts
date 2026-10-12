import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalize, digestOf } from '@vega/verifier';
import { launchRegistry } from '@vega/connectors';
import { FakeProviders } from '@vega/connector-testing';
import { DbosOrchestrator } from '@vega/orchestration';
import type { ActionReceipt, RunStatus } from '@vega/contracts';
import { compileModule, OpaClient, PatternClassifier, PRESET_MODES, presetPolicies } from '@vega/policy-engine';
import { packetDigest } from '@vega/approvals';
import { EvidenceAppendClient } from '@vega/service-execution';
import { ApprovalOrchestrator } from '../../execution/src/approvals/orchestrator.js';
import { executionHooks, programReceipt, RUN_WORKFLOW, runWorkflow, type PendingAction } from '../../execution/src/executor/index.js';
import { PolicyEngine } from '../../execution/src/policy/index.js';
import { connect, dbosUrl, executorKit, ownerQuery, plannedRun, seedTenant, setAgentSpec, silent, waitFor, type ExecutorKit, type Tenant } from '../../execution/test/fixtures.js';
import { evidencePlane, TOKENS, type Plane } from '../../evidence/test/harness.js';
import { injectFetch } from '../src/inject-fetch.js';
import { ApprovalService } from '../src/approvals/service.js';

/**
 * APPROVALS, END TO END (docs/module8.md §8, §11): real runs through the durable executor, decided
 * by the real policy engine, paused on an approval REQUEST (routed, packet rendered and hashed,
 * expiry and fallback declared), decided by a person through the control plane's rules — or
 * escalated, or expired into its fallback by the executor's timers — with every action's signed
 * receipt naming who approved it and the digest of exactly what they were shown.
 */

vi.setConfig({ testTimeout: 90_000 });

const OPA_URL = process.env['OPA_TEST_URL'] ?? 'http://localhost:8182';
const SYSTEM_DB = 'vega_dbos_approvals_test';
const providers = new FakeProviders();
const opa = new OpaClient({ baseUrl: OPA_URL, timeoutMs: 2_000 });
const engine = new PolicyEngine({ opa, classifier: new PatternClassifier(), classifierName: 'pattern-test', log: silent, cacheTtlMs: 0 });
let windowMs = 3_600_000;
let appendToChain: ((e: { tenantId: string; kind: string; payload: Record<string, unknown> }) => Promise<void>) | undefined;
const orch = new ApprovalOrchestrator({ windowMs: () => windowMs, audit: { append: async (e) => appendToChain?.(e) } });
let p: Plane;
let kit: ExecutorKit;
let dbos: DbosOrchestrator;
let svc: ApprovalService;
let t: Tenant;
let bindings: Record<string, string>;
const U = { approver: '', admin: '' };

beforeAll(async () => {
  p = await evidencePlane();
  expect(await opa.healthy(), `OPA must be reachable at ${OPA_URL}`).toBe(true);
  for (const mode of PRESET_MODES) await opa.putPolicy(`presets-${mode}`, compileModule(`vega.presets.${mode}`, presetPolicies(mode)));
  await ownerQuery(`DROP DATABASE IF EXISTS ${SYSTEM_DB} WITH (FORCE)`);
  const evidence = new EvidenceAppendClient('http://evidence.internal', TOKENS.append, injectFetch(p.app));
  const receipts = executionHooks({ log: silent, invoker: { execute: async () => ({ ok: false, error: { code: 'VALIDATION', message: 'unused' } }), simulate: async () => ({ ok: false, error: { code: 'VALIDATION', message: 'unused' } }) }, evidence, requireEvidence: true, policy: (ctx) => engine.decide(ctx) });
  kit = await executorKit(providers.fetch, { policy: (ctx) => engine.decide(ctx), hooks: (h) => ({ ...h, receipt: receipts.receipt }) });
  kit.deps.programReceipt = programReceipt(evidence);
  kit.deps.approvals = orch;
  appendToChain = async (e) => void (await evidence.append(e));
  dbos = new DbosOrchestrator({ appName: 'vega-approvals-test', systemDatabaseUrl: dbosUrl(SYSTEM_DB), logLevel: 'error' });
  dbos.register(RUN_WORKFLOW, runWorkflow(kit.deps));
  await dbos.launch();
  // The control plane's half: the decision is committed on the row, then the run is woken.
  const controlEvidence = { append: async (e: { tenantId: string; kind: string; payload: Record<string, unknown>; content?: Array<{ data: string; mediaType: string; sensitivity?: 'body' | 'metadata' }> }) => (await p.app.inject({ method: 'POST', url: '/append', headers: { authorization: `Bearer ${TOKENS.control}` }, payload: { ...e, source: 'control' } })).json() } as never;
  svc = new ApprovalService({ logger: { info: () => undefined, warn: () => undefined, error: () => undefined, child: () => undefined } as never, evidence: controlEvidence, waker: { wake: async (w) => dbos.send(w.runId, 'decision', { key: w.key, decision: w.decision, by: w.by }) } });
  t = await seedTenant();
  await ownerQuery(`UPDATE tenants SET plan = 'enterprise' WHERE id = $1`, [t.tenantId]);
  await setAgentSpec(t, 1, { allowedTools: launchRegistry().records().map((r) => r.toolId) });
  bindings = { gmail: await connect(t, 'gmail', (s) => providers.grant('google', t.email, s)) };
  const mk = async (role: string, name: string) => (await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, role, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`, [t.tenantId, `${name}@${t.domain}`, name, role]))[0]!.id;
  U.approver = await mk('APPROVER', 'approver');
  U.admin = await mk('ADMIN', 'admin');
}, 120_000);

afterAll(async () => {
  await dbos?.shutdown();
  await p?.close();
});

const until = (runId: string, want: RunStatus[], ms = 45_000) =>
  waitFor(async () => {
    const v = await kit.store.view(t.tenantId, runId);
    return v && want.includes(v.status) ? v : null;
  }, ms, `run ${runId} to reach ${want.join('|')}`);
const start = (runId: string) => dbos.start(RUN_WORKFLOW, runId, { tenantId: t.tenantId, runId });
const actor = (userId: string, role: 'APPROVER' | 'ADMIN' | 'OWNER') => ({ tenantId: t.tenantId, userId, role });
const requestOf = (runId: string) => waitFor(async () => (await orch.store.forRun(t.tenantId, runId))[0] ?? null, 20_000, 'the approval request to open');
const sentTo = (addr: string) => providers.google.sent.filter((m) => JSON.stringify(m).includes(addr));

/** Untrusted content in an outgoing email: the M3 gate requires a person (and Balanced then holds it). */
const program = (to: string, tag: string) =>
  `let inbox = call gmail.search({ query: "${tag}" })\nlet msg = call gmail.read({ messageId: inbox.messages[0].id })\nlet s = extract msg into Summary\ncall gmail.send({ to: ["${to}"], subject: "FYI ${tag}", body: render("summary", { text: s.text }) })\nemit "sent"`;

async function pausedRun(to: string, tag: string) {
  providers.google.seedMessage(t.email, { from: 'Client <client@partner.example>', subject: `${tag} numbers`, body: 'Revenue grew 4%.' });
  const { runId } = await plannedRun(kit, t, program(to, tag), { bindings });
  await start(runId);
  await until(runId, ['AWAITING_APPROVAL']);
  return runId;
}

/** After approval, Balanced holds an outgoing email (2 min): release it as a person would. */
async function releaseIfHeld(runId: string) {
  const v = await waitFor(async () => {
    const s = await kit.store.view(t.tenantId, runId);
    return s && s.status !== 'AWAITING_APPROVAL' && s.status !== 'EXECUTING' ? s : null;
  }, 45_000, 'the run to leave the approval');
  if (v.status === 'HELD') await dbos.send(runId, 'resume', { action: 'release', by: t.userId });
  return v.status;
}

describe('the approval happy path (§8.1)', () => {
  it('routed to the approver, decided on the hashed packet, and the action’s signed receipt says who and what they saw', async () => {
    const to = `boss-flow@${t.domain}`;
    const runId = await pausedRun(to, 'flow-happy');
    const r = await requestOf(runId);
    expect(r).toMatchObject({ state: 'pending', assignedTo: U.approver, approverRole: 'APPROVER', fallback: 'AUTO_REJECT', approvalsRequired: 1 });
    expect(r.expiresAt.getTime()).toBeGreaterThan(Date.now()); // §12: never without an expiry and a fallback
    expect(r.escalateAt).not.toBeNull();
    expect(packetDigest(r.packetJson)).toBe(r.packetDigest);
    const linked = await waitFor(async () => ((await kit.store.view(t.tenantId, runId))?.pending as PendingAction | null)?.approvalRequestId ?? null, 10_000, 'the run to name its approval request');
    expect(linked).toBe(r.id);
    expect(sentTo(to)).toHaveLength(0);

    const a = actor(U.approver, 'APPROVER');
    const pk = await svc.packet(a, r.id);
    expect(pk.packet.evidence.untrusted_fields).toContain('body');
    await svc.evidenceOpened(a, r.id, 1_800);
    await svc.decide(a, r.id, { decision: 'approve', packetDigest: pk.digest });
    expect(await releaseIfHeld(runId)).toMatch(/HELD|COMPLETED/);
    await until(runId, ['COMPLETED']);
    expect(sentTo(to)).toHaveLength(1);

    const [pre] = await p.reader.entries({ tenantId: t.tenantId, runId, toolId: 'gmail.send', kinds: ['action.pre'] }, { limit: 1 });
    const receipt = pre!.payload as unknown as ActionReceipt;
    expect(receipt.approval).toMatchObject({ required: true, granted: true, by: [U.approver], evidence_digest: r.packetDigest, request_id: r.id });
    const [approval] = await p.reader.entries({ tenantId: t.tenantId, kinds: ['approval'], runId }, { limit: 1 });
    expect(approval!.payload).toMatchObject({ request_id: r.id, decision: 'approve', approver: U.approver, evidence_digest: r.packetDigest, evidence_opened: true });
    // What was shown is in the content store, and hashes to the digest the receipt names.
    const shown = await p.content.get(t.tenantId, r.packetDigest);
    expect(digestOf(shown!)).toBe(r.packetDigest);
    expect(digestOf(canonicalize(JSON.parse(shown!.toString('utf8'))))).toBe(r.packetDigest);
  });
});

describe('expiry and the fallback (§8.2 — BLOCKING, time-travel)', () => {
  it('no decision before it expires → AUTO_REJECT: the email is never sent, recorded as an EXPIRY, never as an approval', async () => {
    windowMs = 2_500;
    try {
      const to = `boss-expire@${t.domain}`;
      const runId = await pausedRun(to, 'flow-expire');
      const r = await requestOf(runId);
      expect(r.expiresAt.getTime() - r.createdAt.getTime()).toBe(2_500);
      const done = await until(runId, ['CANCELLED'], 30_000);
      expect(done.statusReason).toMatch(/expired; fallback AUTO_REJECT applied/);
      expect(sentTo(to)).toHaveLength(0);
      expect(await orch.store.get(t.tenantId, r.id)).toMatchObject({ state: 'expired', resolution: 'fallback:AUTO_REJECT', resolvedBy: 'system:expiry' });
      const ds = await orch.store.decisions(t.tenantId, r.id);
      // Half way through it escalated (nobody answered); at the end it expired. Neither is an approval.
      expect(ds.map((d) => [d.decision, d.surface, d.approverId])).toEqual([['escalated', 'system', null], ['expired', 'system', null]]);
      const [entry] = await p.reader.entries({ tenantId: t.tenantId, kinds: ['approval'], runId }, { limit: 1 });
      expect(entry!.payload).toMatchObject({ decision: 'EXPIRED', fallback: 'AUTO_REJECT', packet_digest: r.packetDigest });
      expect(await ownerQuery(`SELECT 1 FROM platform_events WHERE kind = 'approval.expired' AND payload->>'requestId' = $1`, [r.id])).toHaveLength(1);
    } finally {
      windowMs = 3_600_000;
    }
  });
});

describe('escalation (§5.4)', () => {
  it('unanswered past half the window → the next role up decides', async () => {
    windowMs = 6_000;
    try {
      const to = `boss-escalate@${t.domain}`;
      const runId = await pausedRun(to, 'flow-escalate');
      const r = await requestOf(runId);
      const escalated = await waitFor(async () => {
        const row = await orch.store.get(t.tenantId, r.id);
        return row && row.escalationLevel === 1 ? row : null;
      }, 20_000, 'the request to escalate');
      expect(escalated).toMatchObject({ approverRole: 'ADMIN', assignedTo: U.admin, state: 'pending' });
      expect(await ownerQuery(`SELECT 1 FROM platform_events WHERE kind = 'approval.escalated' AND payload->>'requestId' = $1`, [r.id])).toHaveLength(1);
      const a = actor(U.admin, 'ADMIN');
      const pk = await svc.packet(a, r.id);
      await svc.decide(a, r.id, { decision: 'approve', packetDigest: pk.digest });
      await releaseIfHeld(runId);
      await until(runId, ['COMPLETED']);
      expect(sentTo(to)).toHaveLength(1);
    } finally {
      windowMs = 3_600_000;
    }
  });
});

describe('approve with edits (§8.3 — BLOCKING: edits re-trigger risk; a tier increase forces re-approval)', () => {
  it('an edit to the content only keeps the approval: the EDITED email goes out', async () => {
    const to = `boss-edit@${t.domain}`;
    const runId = await pausedRun(to, 'flow-edit');
    const r = await requestOf(runId);
    const a = actor(U.approver, 'APPROVER');
    const pk = await svc.packet(a, r.id);
    await svc.decide(a, r.id, { decision: 'approve_with_edits', packetDigest: pk.digest, edits: { body: 'Revenue grew. Details on Monday.' } });
    await releaseIfHeld(runId);
    await until(runId, ['COMPLETED']);
    const sent = sentTo(to);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain('Details on Monday');
    expect((await orch.store.forRun(t.tenantId, runId)).length).toBe(1); // no second approval
  });

  it('an edit that makes it much riskier (a competitor added) is decided again — and here policy DENIES it: never sent', async () => {
    const runId = await pausedRun(`boss-widen@${t.domain}`, 'flow-widen');
    const r = await requestOf(runId);
    const a = actor(U.approver, 'APPROVER');
    const pk = await svc.packet(a, r.id);
    await svc.decide(a, r.id, { decision: 'approve_with_edits', packetDigest: pk.digest, edits: { to: [`boss-widen@${t.domain}`, 'someone@competitor.example'] } });
    const node = await waitFor(async () => (await kit.store.nodes(t.tenantId, runId)).find((n) => n.toolId === 'gmail.send' && n.status === 'failed') ?? null, 30_000, 'the edited call to be decided again');
    expect(node.error).toMatchObject({ code: 'POLICY_DENIED' });
    const evs = await ownerQuery<{ decision: string; tier: string }>(`SELECT e.decision, r.tier FROM policy_evaluations e JOIN risk_evaluations r ON r.id = e.risk_evaluation_id WHERE e.run_id = $1 AND e.tool_id = 'gmail.send' ORDER BY e.evaluated_at`, [runId]);
    expect(evs.at(-1)).toMatchObject({ decision: 'DENY', tier: 'CRITICAL' }); // the approval did not carry over
    expect(sentTo('someone@competitor.example')).toHaveLength(0);
  });

  it('an edit that ADDS a recipient (even at the same risk tier) never inherits the approval: it is asked again', async () => {
    const runId = await pausedRun(`boss-add@${t.domain}`, 'flow-add');
    const r = await requestOf(runId);
    const a = actor(U.approver, 'APPROVER');
    const pk = await svc.packet(a, r.id);
    await svc.decide(a, r.id, { decision: 'approve_with_edits', packetDigest: pk.digest, edits: { to: [`boss-add@${t.domain}`, `colleague-add@${t.domain}`] } });
    const again = await waitFor(async () => {
      const rs = await orch.store.forRun(t.tenantId, runId);
      return rs.length >= 2 ? rs[0] : null;
    }, 30_000, 'the edited call to need approval again');
    expect(again!.id).not.toBe(r.id);
    expect(again!.state).toBe('pending');
    expect((again!.packetJson as { why: { reasoning: string } }).why.reasoning).toMatch(/the edit (added a recipient \(colleague-add@|raised the risk)/);
    expect(sentTo(`colleague-add@${t.domain}`)).toHaveLength(0);
    const pk2 = await svc.packet(a, again!.id);
    await svc.decide(a, again!.id, { decision: 'approve', packetDigest: pk2.digest });
    await releaseIfHeld(runId);
    await until(runId, ['COMPLETED']);
    expect(sentTo(`colleague-add@${t.domain}`)).toHaveLength(1);
  });
});
