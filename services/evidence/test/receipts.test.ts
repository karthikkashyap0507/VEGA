import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readZip, verifyPack, canonicalize, digestOf } from '@vega/verifier';
import { launchRegistry } from '@vega/connectors';
import { FakeProviders } from '@vega/connector-testing';
import { DbosOrchestrator } from '@vega/orchestration';
import type { ActionReceipt, PolicyActivatedRecord, ReplayTape, RunStatus } from '@vega/contracts';
import { compileModule, OpaClient, PatternClassifier, parsePolicyYaml, PRESET_MODES, presetPolicies, tenantPackage, type Policy } from '@vega/policy-engine';
import { EvidenceAppendClient } from '@vega/service-execution';
import { executionHooks, programReceipt, RUN_WORKFLOW, runWorkflow } from '../../execution/src/executor/index.js';
import { injectFetch } from '@vega/service-control';
import { PolicyEngine } from '../../execution/src/policy/index.js';
import { connect, dbosUrl, executorKit, ownerQuery, plannedRun, seedTenant, setAgentSpec, silent, waitFor, type ExecutorKit, type Tenant } from '../../execution/test/fixtures.js';
import { evidencePlane, json, TOKENS, type Plane } from './harness.js';

/**
 * EXECUTION → EVIDENCE, end to end (module7.md §8.1, §12). Real runs through the durable
 * executor, decided by the real policy engine (OPA + risk), each call writing its §5.1 receipt to
 * the real signed chain BEFORE the provider hears anything; then every action replayed (DRY), the
 * C8 trace read back, and an evidence pack of the run checked by the published verifier.
 */

vi.setConfig({ testTimeout: 60_000 });

const OPA_URL = process.env['OPA_TEST_URL'] ?? 'http://localhost:8182';
const SYSTEM_DB = 'vega_dbos_evidence_test';
const providers = new FakeProviders();
const opa = new OpaClient({ baseUrl: OPA_URL, timeoutMs: 2_000 });
const engine = new PolicyEngine({ opa, classifier: new PatternClassifier(), classifierName: 'pattern-test', log: silent, cacheTtlMs: 0 });
let p: Plane;
let kit: ExecutorKit;
let orchestrator: DbosOrchestrator;
let t: Tenant;
let bindings: Record<string, string>;
/** Swapped by the fail-closed test for a plane that is down. */
let evidence: EvidenceAppendClient;
let effectsBeforeReceipt = 0;

beforeAll(async () => {
  p = await evidencePlane();
  expect(await opa.healthy(), `OPA must be reachable at ${OPA_URL}`).toBe(true);
  for (const mode of PRESET_MODES) await opa.putPolicy(`presets-${mode}`, compileModule(`vega.presets.${mode}`, presetPolicies(mode)));
  await ownerQuery(`DROP DATABASE IF EXISTS ${SYSTEM_DB} WITH (FORCE)`);
  evidence = new EvidenceAppendClient('http://evidence.internal', TOKENS.append, injectFetch(p.app));
  const live = { append: (i: Parameters<EvidenceAppendClient['append']>[0]) => evidence.append(i) } as EvidenceAppendClient;
  const receipts = executionHooks({ log: silent, invoker: { execute: async () => ({ ok: false, error: { code: 'VALIDATION', message: 'unused' } }), simulate: async () => ({ ok: false, error: { code: 'VALIDATION', message: 'unused' } }) }, evidence: live, requireEvidence: true, policy: (ctx) => engine.decide(ctx) });
  kit = await executorKit(providers.fetch, { policy: (ctx) => engine.decide(ctx), hooks: (h) => ({ ...h, receipt: receipts.receipt }) });
  kit.deps.programReceipt = programReceipt(live);
  // The effect must never precede its receipt (invariant 2): checked at the moment of every call.
  kit.onExecute = async (i) => {
    const pre = await p.reader.count({ tenantId: t.tenantId, runId: i.runId, kinds: ['action.pre'] });
    if (pre < Number(i.nodeId.split('.')[1])) effectsBeforeReceipt++;
  };
  orchestrator = new DbosOrchestrator({ appName: 'vega-evidence-test', systemDatabaseUrl: dbosUrl(SYSTEM_DB), logLevel: 'error' });
  orchestrator.register(RUN_WORKFLOW, runWorkflow(kit.deps));
  await orchestrator.launch();
  t = await seedTenant();
  await setAgentSpec(t, 1, { allowedTools: launchRegistry().records().map((r) => r.toolId) });
  bindings = { gmail: await connect(t, 'gmail', (s) => providers.grant('google', t.email, s)), gcal: await connect(t, 'gcal', (s) => providers.grant('google', t.email, s)) };
}, 120_000);

afterAll(async () => {
  await orchestrator?.shutdown();
  await opa.deletePolicy(`tenant-${t?.tenantId}`).catch(() => undefined);
  await p?.close();
});

const until = (runId: string, want: RunStatus[]) =>
  waitFor(async () => {
    const v = await kit.store.view(t.tenantId, runId);
    return v && want.includes(v.status) ? v : null;
  }, 45_000, `run ${runId} to reach ${want.join('|')}`);
const start = (runId: string) => orchestrator.start(RUN_WORKFLOW, runId, { tenantId: t.tenantId, runId });
const entries = async (runId: string) => {
  const out = [];
  for await (const b of p.reader.scan({ tenantId: t.tenantId, runId })) out.push(...b);
  return out;
};

/** The control plane's half: activating a bundle appends its documents to the chain. */
async function activate(policies: Array<{ policy: Policy; version: number }>, version: number) {
  await ownerQuery(`UPDATE policy_bundles SET superseded_at = now() WHERE tenant_id = $1 AND activated_at IS NOT NULL AND superseded_at IS NULL`, [t.tenantId]);
  const rego = compileModule(tenantPackage(t.tenantId), policies);
  await ownerQuery(
    `INSERT INTO policy_bundles (tenant_id, version, policy_ids, policy_versions, rego, revision, bundle_ref, digest, signature, created_by, activated_at, activated_by)
     VALUES ($1, $2, '{}', $3, $4, $5, 'test', 'sha256:test', 'test', $6, now(), $6)`,
    [t.tenantId, version, JSON.stringify(policies.map((x) => ({ key: x.policy.id, version: x.version }))), rego, `t@v${version}`, t.userId],
  );
  await opa.putPolicy(`tenant-${t.tenantId}`, rego);
  const docs = policies.map((x) => json(x.policy));
  const record: PolicyActivatedRecord = {
    bundle_id: `bundle-v${version}`,
    version,
    previous_version: null,
    digest: 'sha256:test',
    simulation_id: null,
    activated_by: t.userId,
    policies: policies.map((x) => ({ key: x.policy.id, version: x.version, document_digest: digestOf(Buffer.from(JSON.stringify(x.policy))), citation: x.policy.citation ?? null })),
  };
  const r = await p.app.inject({ method: 'POST', url: '/append', headers: { authorization: `Bearer ${TOKENS.control}` }, payload: { tenantId: t.tenantId, source: 'control', kind: 'policy.activated', payload: record as unknown as Record<string, unknown>, content: docs } });
  expect(r.statusCode).toBe(201);
}

let runId: string;

describe('every action is recorded BEFORE it happens (§12)', () => {
  it('a run that reads, extracts, drafts and sends: run.program, then action.pre → call → action.post for each call', async () => {
    await activate(parsePolicyYaml(`
- id: drafts-are-noted
  description: Drafts are allowed and cited
  severity: normal
  citation: Internal records policy 4.2
  when: { tool.id: gmail.draft }
  then: { decision: ALLOW }
`).map((policy) => ({ policy, version: 3 })), 1);
    const to = `colleague-evidence@${t.domain}`;
    providers.google.seedMessage(t.email, { from: `Colleague <peer@${t.domain}>`, subject: 'evidence-probe notes', body: 'Numbers are final.' });
    ({ runId } = await plannedRun(
      kit,
      t,
      `let inbox = call gmail.search({ query: "evidence-probe" })\nlet msg = call gmail.read({ messageId: inbox.messages[0].id })\nlet s = extract msg into Summary\ncall gmail.draft({ to: ["${to}"], subject: "Notes", body: render("summary", { text: s.text }) })\ncall gmail.send({ to: ["${to}"], subject: "Plain", body: "See you at ten" })\nemit "done"`,
      { bindings },
    ));
    await start(runId);
    // Balanced holds anything leaving the organization (2 min): released early, it runs once.
    await until(runId, ['HELD']);
    expect(await p.reader.count({ tenantId: t.tenantId, runId, toolId: 'gmail.send' })).toBe(0); // held: no receipt yet, nothing sent
    await orchestrator.send(runId, 'resume', { action: 'release', by: t.userId });
    await until(runId, ['COMPLETED']);
    expect(effectsBeforeReceipt).toBe(0);

    const es = await entries(runId);
    expect(es.map((e) => [e.kind, e.facets.toolId])).toEqual([
      ['run.program', null],
      ['action.pre', 'gmail.search'],
      ['action.post', 'gmail.search'],
      ['action.pre', 'gmail.read'],
      ['action.post', 'gmail.read'],
      ['action.pre', 'gmail.draft'],
      ['action.post', 'gmail.draft'],
      ['action.pre', 'gmail.send'],
      ['action.post', 'gmail.send'],
    ]);
    const draft = es.find((e) => e.kind === 'action.pre' && e.facets.toolId === 'gmail.draft')!.payload as unknown as ActionReceipt;
    expect(draft).toMatchObject({
      receipt_version: 1,
      phase: 'pre',
      run_id: runId,
      actor: { principal: t.userId, agent: t.agentId },
      tool: { id: 'gmail.draft', reversibility: 'R1' },
      arg_taint: 'UNTRUSTED',
      program: { version: 1, call_seq: 3 },
      model: { id: 'test' },
      policy: { decision: 'ALLOW', preset: 'balanced', preset_version: 1, bundle_version: 1 },
      risk: { weights_version: 1 },
      subjects: [`@${t.domain}`, to],
    });
    expect(draft.policies_evaluated.map((x) => x.id)).toContain('drafts-are-noted');
    expect(draft.inputs_read.some((i) => i.taint === 'UNTRUSTED')).toBe(true);
    expect(draft.arguments_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(draft.replay_tape_digest).toMatch(/^sha256:/);
    // Digests, never plaintext: the receipt does not contain the message body.
    expect(JSON.stringify(draft)).not.toContain('Numbers are final');
    const sendPre = es.find((e) => e.kind === 'action.pre' && e.facets.toolId === 'gmail.send')!.payload as unknown as ActionReceipt;
    expect(sendPre.policy).toMatchObject({ decision: 'ALLOW_WITH_HOLD', decided_by: 'external-send-hold' });
    expect(sendPre.hold).toEqual({ window_ms: 120_000, released: true, revoked: false });
    const sendPost = es.find((e) => e.kind === 'action.post' && e.facets.toolId === 'gmail.send')!;
    expect(sendPost.payload).toMatchObject({ outcome: 'COMMITTED', effect_digest: expect.stringMatching(/^sha256:/) });
    expect(sendPost.facets.outcome).toBe('COMMITTED');
  });

  it('the content a receipt names is in the store and hashes to the digest', async () => {
    const [pre] = await p.reader.entries({ tenantId: t.tenantId, runId, toolId: 'gmail.send', kinds: ['action.pre'] }, { limit: 1 });
    const r = pre!.payload as unknown as ActionReceipt;
    const args = await p.content.getJson<{ to: string[]; body: string }>(t.tenantId, r.arguments_digest);
    expect(args).toMatchObject({ subject: 'Plain', body: 'See you at ten' });
    expect(digestOf(canonicalize(args))).toBe(r.arguments_digest);
  });
});

describe('deterministic replay (§5.7): every action of the run', () => {
  it('reproduces the interpreter, risk and policy layers EXACTLY — and calls nothing', async () => {
    const pres = (await entries(runId)).filter((e) => e.kind === 'action.pre');
    const providerCalls = providers.core.calls.length;
    for (const e of pres) {
      const r = (await p.replay.replay(t.tenantId, e.facets.actionId!, 'auditor-1'))!;
      expect(r.layers.filter((l) => l.status !== 'match').map((l) => `${l.layer}: ${l.detail}`), e.facets.toolId!).toEqual([]);
      expect(r).toMatchObject({ matched: true, conclusive: true });
      expect(r.originalDigest).toBe(r.replayDigest);
    }
    // DRY: replay answered every earlier call from the tape; no provider saw anything.
    expect(providers.core.calls.length).toBe(providerCalls);
    const recorded = await p.reader.entries({ tenantId: t.tenantId, kinds: ['replay.recorded'] }, { limit: 10 });
    expect(recorded.length).toBeGreaterThanOrEqual(4);
  });

  it('a decision that does not follow from its inputs is reported as a divergence, layer by layer', async () => {
    const [pre] = await p.reader.entries({ tenantId: t.tenantId, runId, toolId: 'gmail.draft', kinds: ['action.pre'] }, { limit: 1 });
    const receipt = pre!.payload as unknown as ActionReceipt;
    const tape = (await p.content.getJson<ReplayTape>(t.tenantId, receipt.replay_tape_digest!))!;
    const forged: ReplayTape = { ...tape, target: { ...tape.target, args_digest: digestOf('different arguments') }, decision: { ...tape.decision!, recorded: { ...tape.decision!.recorded, decision: 'DENY', risk_score: 99 } } };
    const r = await p.app.inject({ method: 'POST', url: '/append', headers: { authorization: `Bearer ${TOKENS.append}` }, payload: { tenantId: t.tenantId, source: 'execution', kind: 'action.pre', payload: { ...receipt, action_id: 'forged-action', run_id: 'forged-run', replay_tape_digest: digestOf(canonicalize(forged)) }, content: [{ data: Buffer.from(canonicalize(forged)).toString('base64'), mediaType: 'application/json' }] } });
    expect(r.statusCode).toBe(201);
    const out = (await p.replay.replay(t.tenantId, 'forged-action', 'auditor-1'))!;
    expect(out.matched).toBe(false);
    expect(Object.fromEntries(out.layers.map((l) => [l.layer, l.status]))).toEqual({ interpreter: 'diverged', risk: 'diverged', policy: 'diverged', model: 'match' });
  });

  it('a tape that asks for a call it never recorded is refused — replay cannot reach a provider', async () => {
    const [pre] = await p.reader.entries({ tenantId: t.tenantId, runId, toolId: 'gmail.send', kinds: ['action.pre'] }, { limit: 1 });
    const receipt = pre!.payload as unknown as ActionReceipt;
    const tape = (await p.content.getJson<ReplayTape>(t.tenantId, receipt.replay_tape_digest!))!;
    const starved: ReplayTape = { ...tape, calls: [] }; // the program's earlier calls are gone from the tape
    await p.app.inject({ method: 'POST', url: '/append', headers: { authorization: `Bearer ${TOKENS.append}` }, payload: { tenantId: t.tenantId, source: 'execution', kind: 'action.pre', payload: { ...receipt, action_id: 'starved-action', run_id: 'forged-run', replay_tape_digest: digestOf(canonicalize(starved)) }, content: [{ data: Buffer.from(canonicalize(starved)).toString('base64'), mediaType: 'application/json' }] } });
    const before = providers.core.calls.length;
    const out = (await p.replay.replay(t.tenantId, 'starved-action', 'auditor-1'))!;
    expect(out.layers.find((l) => l.layer === 'interpreter')).toMatchObject({ status: 'diverged', detail: expect.stringMatching(/not on the tape/) });
    expect(providers.core.calls.length).toBe(before);
  });
});

describe('replay determinism across varied programs (§11: ≥ 99% on the deterministic layers)', () => {
  /** Drives a run to the end the way a person would: releasing holds, approving approvals. */
  async function finish(id: string) {
    for (let i = 0; i < 10; i++) {
      const v = await until(id, ['COMPLETED', 'FAILED', 'HELD', 'AWAITING_APPROVAL', 'NEEDS_ATTENTION', 'CANCELLED']);
      if (v.status === 'HELD') await orchestrator.send(id, 'resume', { action: 'release', by: t.userId });
      else if (v.status === 'AWAITING_APPROVAL') await orchestrator.send(id, 'decision', { key: (v.pending as { key: string }).key, decision: 'approve', by: t.userId });
      else return v.status;
      await waitFor(async () => ((await kit.store.view(t.tenantId, id))!.status !== v.status ? true : null), 20_000, 'the run to move on');
    }
    throw new Error('run did not finish');
  }

  it('branches, map over calls, directory resolution, extraction, calendar writes — every action replays exactly', async () => {
    const d = t.domain;
    providers.google.seedMessage(t.email, { from: `Ops <ops@${d}>`, subject: 'det-A report', body: 'Ready.' });
    for (const n of [1, 2, 3]) providers.google.seedMessage(t.email, { from: `Peer${n} <p${n}@${d}>`, subject: `det-B item ${n}`, body: `Item ${n}` });
    providers.google.seedMessage(t.email, { from: 'Client <c@partner.example>', subject: 'det-D brief', body: 'Please summarize: revenue up 4%.' });
    const programs = [
      `let inbox = call gmail.search({ query: "det-A" })\nlet n = count(inbox.messages)\nwhen n > 0 {\n  call gmail.draft({ to: ["peer@${d}"], subject: "Found", body: "yes" })\n} otherwise {\n  call gmail.draft({ to: ["peer@${d}"], subject: "None", body: "no" })\n}\nemit n`,
      `let inbox = call gmail.search({ query: "det-Z-nothing" })\nwhen count(inbox.messages) > 0 {\n  call gmail.draft({ to: ["peer@${d}"], subject: "Found", body: "yes" })\n} otherwise {\n  call gmail.draft({ to: ["peer@${d}"], subject: "None", body: "no" })\n}\nemit "checked"`,
      `let inbox = call gmail.search({ query: "det-B" })\nlet bodies = map inbox.messages as m limit 3 { call gmail.read({ messageId: m.id }) }\nemit count(bodies)`,
      `let who = resolve "${t.email}" in directory\ncall gcal.create({ summary: "Det sync", start: "2026-11-03T10:00:00Z", end: "2026-11-03T10:30:00Z", attendees: [who.email] })\nemit "ok"`,
      `let inbox = call gmail.search({ query: "det-D" })\nlet msg = call gmail.read({ messageId: inbox.messages[0].id })\nlet s = extract msg into Summary\ncall gmail.draft({ to: ["peer@${d}"], subject: "Brief", body: render("summary", { text: s.text }) })\nemit "drafted"`,
      `call gmail.send({ to: ["peer@${d}"], subject: "Det", body: "A held send, released" })\nemit "sent"`,
    ];
    const runs: string[] = [];
    for (const src of programs) {
      const { runId: id } = await plannedRun(kit, t, src, { bindings });
      await start(id);
      expect(await finish(id), src.split('\n')[0]).toBe('COMPLETED');
      runs.push(id);
    }
    const providerCalls = providers.core.calls.length;
    let total = 0;
    let matched = 0;
    const misses: string[] = [];
    for (const id of runs) {
      for (const e of (await entries(id)).filter((x) => x.kind === 'action.pre')) {
        total++;
        const r = (await p.replay.replay(t.tenantId, e.facets.actionId!, 'determinism-eval', { record: false }))!;
        if (r.matched && r.conclusive) matched++;
        else misses.push(`${e.facets.toolId}: ${r.layers.filter((l) => l.status !== 'match').map((l) => `${l.layer} ${l.status} — ${l.detail}`).join('; ')}`);
      }
    }
    expect(misses).toEqual([]);
    expect(total).toBeGreaterThanOrEqual(12);
    expect(matched / total).toBeGreaterThanOrEqual(0.99);
    expect(providers.core.calls.length).toBe(providerCalls); // replay never reached a provider
  }, 180_000);
});

describe('C8 trace (§5.9) and a pack of the run', () => {
  it('answers the six questions from the chain', async () => {
    const tr = (await p.trace.build(t.tenantId, runId, { bodies: true }))!;
    expect(tr.integrity).toMatchObject({ ok: true, failures: [] });
    expect(tr.what.map((w) => w.tool)).toEqual(['gmail.draft', 'gmail.send']); // what it did (reads are not "done")
    expect(tr.why.objective).toBe('test objective'); // why
    expect(tr.why.programs).toHaveLength(1);
    expect(tr.tools.map((x) => x.tool)).toEqual(['gmail.search', 'gmail.read', 'gmail.draft', 'gmail.send']); // which tools
    expect(tr.tools[3]!.arguments).toMatchObject({ body: 'See you at ten' });
    expect(tr.influences.some((i) => i.taint === 'UNTRUSTED')).toBe(true); // what influenced it
    expect(tr.policies.find((x) => x.tool === 'gmail.draft')!.evaluated.map((e) => e.id)).toContain('drafts-are-noted'); // policies
    expect(tr.approvals.find((a) => a.tool === 'gmail.send')).toMatchObject({ required: false, hold: { window_ms: 120_000, released: true } }); // approval / oversight
    const redacted = (await p.trace.build(t.tenantId, runId, { bodies: false }))!;
    expect(redacted.tools[3]!.arguments).toMatchObject({ redacted: 'requires audit.read_bodies' });
  });

  it('the run’s pack verifies, policies/ carries the tenant policy in force', async () => {
    const id = await p.packs.request({ tenantId: t.tenantId, tenantSlug: 'acme', query: { runId }, requestedBy: 'officer-1', includeBodies: true });
    await p.packs.wait(id);
    const row = (await p.reader.pack(t.tenantId, id))!;
    expect(row.build).toMatchObject({ status: 'built' });
    const files = readZip(new Uint8Array((await p.packs.download(row))!));
    const report = verifyPack(files, { trustedKeys: await p.chain.publicKeys() });
    expect(report.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(report.verified).toBe(true);
    expect([...files.keys()]).toContain('policies/drafts-are-noted@3.json');
    expect(JSON.parse(new TextDecoder().decode(files.get('models.json')))).toMatchObject({ models: [{ model: 'test', actions: 4 }] });
  });
});

describe('FAIL CLOSED (§8.1, BLOCKING): the evidence plane is down', () => {
  it('no receipt → the action never happens and the run says why', async () => {
    const live = evidence;
    evidence = new EvidenceAppendClient('http://evidence.internal', TOKENS.append, async () => new Response('down', { status: 503 }));
    try {
      const subject = 'evidence-down';
      const drafts = () => providers.core.calls.filter((c) => c.method === 'POST' && c.url.includes('/drafts')).length;
      const draftsBefore = drafts();
      const { runId: down } = await plannedRun(kit, t, `call gmail.draft({ to: ["peer@${t.domain}"], subject: "${subject}", body: "y" })\nemit "drafted"`, { bindings });
      await start(down);
      const v = await until(down, ['FAILED', 'NEEDS_ATTENTION']);
      expect(drafts()).toBe(draftsBefore);
      expect(v.statusReason).toMatch(/no audit receipt could be written/);
      const node = (await kit.store.nodes(t.tenantId, down)).find((n) => n.toolId === 'gmail.draft');
      expect(node).toMatchObject({ status: 'failed', error: { code: 'RECEIPT_UNAVAILABLE' } });
    } finally {
      evidence = live;
    }
  });
});
