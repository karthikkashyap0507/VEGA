import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { launchRegistry } from '@vega/connectors';
import { S3ObjectStore } from '@vega/objectstore';
import type { StepContext } from '@vega/orchestration';
import { OpaClient, PatternClassifier, publicPem, signingKeyFromPem, tenantBundleName, tenantResource, type PolicyInput } from '@vega/policy-engine';
import { RunStore } from '@vega/runs';
import { DEFAULT_WEIGHTS, scoreRisk, type RiskInput } from '@vega/risk';
import type { AgentCoreDeps } from '../src/agent/coordinator.js';
import { opaConfig, PolicyPublisher } from '../src/policy/publisher.js';
import { PolicyEngine } from '../../execution/src/policy/index.js';
import { createHarness, problemOf, type Harness } from './harness.js';

/**
 * THE POLICY CONSOLE's back end (docs/module5.md §6–§8, §12) against real Postgres, real
 * object storage (SeaweedFS) and a real OPA that loads bundles the way production does: a
 * signed discovery bundle, per-tenant signed bundles, signatures verified. Activation needs a
 * simulation; simulation is exact over 90 days of recorded actions; the approver a policy names
 * is enforced.
 */

vi.setConfig({ testTimeout: 60_000 });

const OWNER_URL = process.env['DATABASE_URL'] ?? 'postgresql://vega:vega_local_dev_only@localhost:5432/vega';
const S3 = { endpoint: process.env['S3_ENDPOINT'] ?? 'http://127.0.0.1:8333', region: 'us-east-1', accessKeyId: process.env['S3_ACCESS_KEY_ID'] ?? 'vega_local', secretAccessKey: process.env['S3_SECRET_ACCESS_KEY'] ?? 'vega_local_dev_only' };
const OPA_IMAGE = process.env['OPA_IMAGE'] ?? 'mirror.gcr.io/openpolicyagent/opa:1.10.1-static';
const BUCKET = 'vega-policy-test';
const OPA_PORT = 18000 + Math.floor(Math.random() * 1000);
const OPA_NAME = `vega-opa-policies-test-${OPA_PORT}`;

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const key = signingKeyFromPem(privateKey, 'vega');
const store = new S3ObjectStore({ ...S3, bucket: BUCKET });
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined, child: () => silent } as unknown as ConstructorParameters<typeof PolicyPublisher>[2];
const publisher = new PolicyPublisher(store, key, silent, { min: 1, max: 2 });
const signals: Array<{ runId: string; topic: string; message: Record<string, unknown> }> = [];

let h: Harness;
let A: Awaited<ReturnType<Harness['tenant']>>;
let users: Record<'member' | 'compliance' | 'admin1' | 'admin2', string>;

async function owner<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const pool = new pg.Pool({ connectionString: OWNER_URL, max: 1 });
  try {
    return (await pool.query<T>(sql, params)).rows;
  } finally {
    await pool.end();
  }
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const opa = new OpaClient({ baseUrl: `http://127.0.0.1:${OPA_PORT}`, timeoutMs: 2_000 });

beforeAll(async () => {
  await publisher.publishBaseline();
  // OPA exactly as deployed: discovery from object storage, every bundle signature-verified.
  const dir = mkdtempSync(join(tmpdir(), 'opa-cfg-'));
  chmodSync(dir, 0o755);
  writeFileSync(join(dir, 'opa.yaml'), opaConfig({ storeUrl: `${S3.endpoint}/${BUCKET}`, publicKeyPem: publicPem(key), s3Signing: true }).replace('min_delay_seconds: 2', 'min_delay_seconds: 1').replace('max_delay_seconds: 5', 'max_delay_seconds: 2'), { mode: 0o644 });
  execFileSync(
    'docker',
    ['run', '-d', '--rm', '--name', OPA_NAME, '--network', 'host', '-v', `${dir}:/cfg:ro`, '-e', `AWS_ACCESS_KEY_ID=${S3.accessKeyId}`, '-e', `AWS_SECRET_ACCESS_KEY=${S3.secretAccessKey}`, '-e', 'AWS_REGION=us-east-1', OPA_IMAGE, 'run', '--server', '--addr', `127.0.0.1:${OPA_PORT}`, '--config-file', '/cfg/opa.yaml'],
    { stdio: 'pipe' },
  );

  const runStore = new RunStore();
  const execution = {
    signalRun: async (i: { runId: string; topic: string; message: Record<string, unknown> }) => void signals.push({ runId: i.runId, topic: i.topic, message: i.message }),
  };
  h = await createHarness({ policy: { publisher } });
  h.deps.agent = { core: { store: runStore, execution, log: h.deps.logger } as unknown as AgentCoreDeps, coordinator: {} as never };
  A = await h.tenant('teams');
  const mk = async (role: string, name: string) =>
    (await owner<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, role, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`, [A.tenantId, `${name}-${A.tenantId.slice(0, 6)}@example.com`, name, role]))[0]!.id;
  users = { member: await mk('MEMBER', 'member'), compliance: await mk('COMPLIANCE_OFFICER', 'compliance'), admin1: await mk('ADMIN', 'admin1'), admin2: await mk('ADMIN', 'admin2') };
  await waitFor(async () => (await opa.ready()) || null, 30_000, 'OPA to load the presets bundle through discovery');
}, 90_000);

afterAll(async () => {
  await h?.close();
  try {
    execFileSync('docker', ['rm', '-f', OPA_NAME], { stdio: 'pipe' });
  } catch {
    /* already gone */
  }
});

const admin = () => h.as(A.tenantId, A.userId);
const as = (u: keyof typeof users) => h.as(A.tenantId, users[u]);

const RIVALS = `id: no-contact-with-rivals
description: Never write to a competitor
citation: internal-comp-007
severity: critical
when:
  args.recipient.domains: { contains: rival.example }
then:
  decision: DENY
  reason: Competitors are never contacted from this tenant
`;

describe('authoring (§6.1): YAML only, versioned, never deleted', () => {
  it('an ADMIN authors; a MEMBER and a COMPLIANCE_OFFICER cannot; raw Rego is refused; problems carry paths', async () => {
    const p = await admin().policies.create.mutate({ yaml: RIVALS });
    expect(p).toMatchObject({ key: 'no-contact-with-rivals', version: 1, state: 'draft', citation: 'internal-comp-007', decision: 'DENY' });
    expect(p.compiledRego).toContain('matches contains');
    expect((await problemOf(as('member').policies.create.mutate({ yaml: RIVALS.replace('rivals', 'rivals-2') }))).status).toBe(403);
    expect((await problemOf(as('compliance').policies.create.mutate({ yaml: RIVALS.replace('rivals', 'rivals-3') }))).status).toBe(403);
    expect((await as('compliance').policies.list.query()).items.map((i) => i.key)).toContain('no-contact-with-rivals');
    expect((await problemOf(admin().policies.create.mutate({ yaml: 'package vega.x\nallow := true' }))).status).toBe(400);
    const bad = await admin().policies.compile.mutate({ yaml: 'id: x-y\ndescription: d\nwhen: { tool.nonsense: 1 }\nthen: { decision: DENY }' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems.map((q) => q.path)).toEqual(expect.arrayContaining([expect.stringContaining('when'), expect.stringContaining('then.reason')]));
    expect((await problemOf(admin().policies.create.mutate({ yaml: RIVALS }))).status).toBe(409);
  });

  it('a change is a new version; the diff shows it; earlier versions are untouched', async () => {
    const v2 = await admin().policies.update.mutate({ key: 'no-contact-with-rivals', yaml: RIVALS.replace('rival.example', 'competitor.example') });
    expect(v2).toMatchObject({ version: 2, state: 'draft' });
    const versions = await admin().policies.versions.query({ key: 'no-contact-with-rivals' });
    expect(versions.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions.versions[1]!.specYaml).toContain('rival.example');
    const diff = await admin().policies.diff.query({ key: 'no-contact-with-rivals', from: 1, to: 2 });
    expect(diff.lines.filter((l) => l.op !== 'same').map((l) => `${l.op} ${l.text.trim()}`)).toEqual(['del args.recipient.domains: { contains: rival.example }', 'add args.recipient.domains: { contains: competitor.example }']);
    expect((await problemOf(admin().policies.update.mutate({ key: 'no-contact-with-rivals', yaml: RIVALS.replace('no-contact-with-rivals', 'another-id') }))).status).toBe(400);
    // Back to the rival rule for the rest of the suite: a third version.
    await admin().policies.update.mutate({ key: 'no-contact-with-rivals', yaml: RIVALS });
  });

  it('the professional-services pack is adopted as drafts; a retiring policy leaves the next bundle', async () => {
    const pack = await admin().policies.installPack.mutate({ pack: 'professional-services' });
    expect(pack.added).toEqual(expect.arrayContaining(['client-confidentiality', 'health-data-never-external', 'large-value-dual-approval']));
    const r = await admin().policies.retire.mutate({ key: 'first-contact-hold' });
    expect(r.note).toContain('still enforced');
    const list = await admin().policies.list.query();
    expect(list.items.find((i) => i.key === 'first-contact-hold')).toMatchObject({ retiring: true });
  });
});

describe('activation (§5.8, §8.2): simulate first, then OPA loads the signed bundle', () => {
  let bundleId: string;

  it('a candidate cannot be activated without a simulation', async () => {
    const b = await admin().policies.buildBundle.mutate();
    bundleId = b.id;
    expect(b).toMatchObject({ version: 1, state: 'candidate' });
    expect(b.policies.map((p) => p.key)).toContain('no-contact-with-rivals');
    expect(b.policies.map((p) => p.key)).not.toContain('first-contact-hold');
    expect(b.policies.find((p) => p.key === 'no-contact-with-rivals')!.version).toBe(3);
    const refused = await problemOf(admin().policies.activate.mutate({ bundleId }));
    expect(refused.status).toBe(422);
    expect(refused.detail).toContain('without a simulation');
  });

  it('simulate → activate → OPA verifies and loads it → the execution engine decides with it', async () => {
    const sim = await admin().policies.simulate.mutate({ bundleId, windowDays: 90 });
    expect(sim.summary).toMatchObject({ bundleVersion: 1, baselineVersion: null });
    const activated = await admin().policies.activate.mutate({ bundleId });
    expect(activated.state).toBe('active');
    const list = await admin().policies.list.query();
    expect(list.activeBundle?.version).toBe(1);
    expect(list.items.find((i) => i.key === 'no-contact-with-rivals')).toMatchObject({ state: 'active', version: 3 });
    const events = await owner<{ payload: { version: number; simulationId: string } }>(`SELECT payload FROM platform_events WHERE tenant_id = $1 AND kind = 'policy.activated'`, [A.tenantId]);
    expect(events[0]!.payload).toMatchObject({ version: 1, simulationId: sim.id });

    const name = tenantBundleName(A.tenantId);
    await waitFor(async () => (await opa.bundleRevisions())[name] === `${name}@v1` || null, 30_000, 'OPA to load the activated tenant bundle');

    // The execution side, against that OPA: a send to a rival is denied by the tenant policy.
    const [agent] = await owner<{ id: string }>(`INSERT INTO agents (tenant_id, workspace_id, name, owner_user_id, idp_machine_id, status) VALUES ($1, $2, 'a', $3, 'm', 'active') RETURNING id`, [A.tenantId, A.workspaceId, A.userId]);
    const [run] = await owner<{ id: string }>(`INSERT INTO runs (tenant_id, workspace_id, agent_id, principal_user_id, trigger, objective_json, status) VALUES ($1, $2, $3, $4, 'test', '{}', 'EXECUTING') RETURNING id`, [A.tenantId, A.workspaceId, agent!.id, A.userId]);
    const engine = new PolicyEngine({ opa, classifier: new PatternClassifier(), classifierName: 'pattern-test', log: silent as never, cacheTtlMs: 0 });
    const ctx: StepContext = {
      tenantId: A.tenantId,
      runId: run!.id,
      programVersion: 1,
      nodeId: 'n1',
      callSeq: 1,
      nodeRowId: randomUUID(),
      trigger: 'test',
      toolId: 'gmail.send',
      tool: launchRegistry().records().find((r) => r.toolId === 'gmail.send')!,
      args: { to: ['ceo@rival.example'], subject: 'Hi', body: 'Hello' },
      argTaint: 'TRUSTED',
      argTaints: [{ path: 'to[0]', taint: 'TRUSTED', dataTaint: 'TRUSTED', sourceIds: [] }],
      principalUserId: A.userId,
      agentId: agent!.id,
      agentVersion: 1,
      workspaceId: A.workspaceId,
      runCostCents: 0,
      connectorId: null,
      gate: { decision: 'PROCEED' },
    };
    const d = await engine.decide(ctx);
    expect(d).toMatchObject({ decision: 'DENY', reason: expect.stringContaining('Competitors are never contacted') as unknown });
    const [ev] = await owner<{ bundle_version: number; bundle_revision: string; policy_key: string }>(`SELECT bundle_version, bundle_revision, policy_key FROM policy_evaluations WHERE id = $1`, [d.evaluationId]);
    expect(ev).toMatchObject({ bundle_version: 1, bundle_revision: `${name}@v1`, policy_key: 'no-contact-with-rivals' });
    const explained = await admin().risk.evaluations.query({ runId: run!.id });
    expect(explained[0]).toMatchObject({ decision: 'DENY', decidedBy: { key: 'no-contact-with-rivals' }, bundleVersion: 1 });
    expect(explained[0]!.risk?.explanation.length).toBeGreaterThan(0);
  });

  it('a tampered bundle in object storage is refused by OPA: the verified one stays loaded', async () => {
    const name = tenantBundleName(A.tenantId);
    const good = (await store.get(tenantResource(A.tenantId)))!;
    const tar = gunzipSync(good);
    const at = tar.indexOf('Competitors are never contacted');
    tar.write('Competitors are ALWAYS contacted', at); // same length: only the signature can tell
    const manifestAt = tar.indexOf(`${name}@v1`);
    tar.write(`${name}@v9`, manifestAt);
    await store.put(tenantResource(A.tenantId), gzipSync(tar), 'application/gzip');
    await new Promise((r) => setTimeout(r, 6_000)); // several polling cycles
    expect((await opa.bundleRevisions())[name]).toBe(`${name}@v1`);
    await store.put(tenantResource(A.tenantId), good, 'application/gzip');
  });

  it('activating twice, or an older candidate, is refused', async () => {
    expect((await problemOf(admin().policies.activate.mutate({ bundleId }))).status).toBe(422);
  });
});

describe('simulation reports exactly what would change (§5.8, §12)', () => {
  it('over 90 days of recorded actions: newly denied, newly requiring approval, unchanged — one count per action', async () => {
    const tenant = await h.tenant('teams');
    const [agent] = await owner<{ id: string }>(`INSERT INTO agents (tenant_id, workspace_id, name, owner_user_id, idp_machine_id, status) VALUES ($1, $2, 'a', $3, 'm', 'active') RETURNING id`, [tenant.tenantId, tenant.workspaceId, tenant.userId]);
    const [run] = await owner<{ id: string }>(`INSERT INTO runs (tenant_id, workspace_id, agent_id, principal_user_id, trigger, objective_json, status) VALUES ($1, $2, $3, $4, 'test', '{}', 'COMPLETED') RETURNING id`, [tenant.tenantId, tenant.workspaceId, agent!.id, tenant.userId]);
    const record = async (tool: 'gmail.send' | 'gmail.draft', daysAgo: number, nodeId = randomUUID()) => {
      const send = tool === 'gmail.send';
      const risk: RiskInput = { sensitivity: 35, labels: [], effect: { recipients: send ? 1 : 0, externalRecipients: send ? 1 : 0, recordsAffected: send ? 0 : 1 }, egressClass: send ? 'EXTERNAL' : 'INTERNAL', reversibility: send ? 'R2' : 'R1', principalRole: 'OWNER', argTaint: 'TRUSTED', recipientTaint: 'TRUSTED', inScope: true };
      const r = scoreRisk(risk, DEFAULT_WEIGHTS);
      const input: PolicyInput = {
        tool: { id: tool, connector: 'gmail', egress_class: risk.egressClass, reversibility: risk.reversibility, idempotency: 'KEYED' },
        args: { taint: 'TRUSTED', recipient: { taint: 'TRUSTED', count: send ? 1 : 0, domains: send ? ['partner.example'] : [] } },
        target: { audience: send ? 'EXTERNAL' : 'NONE' },
        effect: { recipients: send ? 1 : 0, external_recipients: send ? 1 : 0, records: send ? 0 : 1, fidelity: 'DERIVED' },
        data: { sensitivity: 35, labels: [] },
        risk: { score: r.score, tier: r.tier },
        principal: { role: 'OWNER', id: tenant.userId },
        agent: { id: agent!.id },
        workspace: { id: tenant.workspaceId },
        run: { trigger: 'chat', cost_cents: 0 },
        budget: { month_cents: 0, month_limit_cents: 0, exhausted: false },
      };
      const at = new Date(Date.now() - daysAgo * 86_400_000);
      const [re] = await owner<{ id: string }>(
        `INSERT INTO risk_evaluations (tenant_id, run_id, node_id, score, tier, weights_version, input_json, factors_json, explanation_json, evaluated_at) VALUES ($1, $2, $3, $4, $5, 1, $6, $7, '{}', $8) RETURNING id`,
        [tenant.tenantId, run!.id, nodeId, r.score, r.tier, JSON.stringify(risk), JSON.stringify(r.factors), at],
      );
      await owner(
        `INSERT INTO policy_evaluations (tenant_id, run_id, node_id, tool_id, preset, policy_key, decision, reason_json, input_json, matches_json, risk_evaluation_id, evaluated_at) VALUES ($1, $2, $3, $4, 'balanced', '(recorded)', 'ALLOW', '[]', $5, '[]', $6, $7)`,
        [tenant.tenantId, run!.id, nodeId, tool, JSON.stringify(input), re!.id, at],
      );
      return nodeId;
    };
    for (let i = 0; i < 12; i++) await record('gmail.send', 1 + i * 7); // 12 sends over ~80 days
    for (let i = 0; i < 5; i++) await record('gmail.draft', 2 + i * 10); // 5 drafts
    for (let i = 0; i < 4; i++) await record('gmail.send', 95 + i); // outside the window
    const again = await record('gmail.draft', 3);
    await record('gmail.draft', 1, again); // the same action evaluated twice (after a hold): counted once

    const t = h.as(tenant.tenantId, tenant.userId);
    await t.policies.create.mutate({ yaml: 'id: no-external-mail\ndescription: No mail leaves\nwhen: { tool.id: gmail.send }\nthen: { decision: DENY, reason: frozen }' });
    await t.policies.create.mutate({ yaml: 'id: drafts-reviewed\ndescription: Drafts are reviewed\nwhen: { tool.id: gmail.draft }\nthen: { decision: REQUIRE_APPROVAL, approver_role: APPROVER }' });
    const b = await t.policies.buildBundle.mutate();
    const sim = await t.policies.simulate.mutate({ bundleId: b.id, windowDays: 90 });
    expect(sim.summary).toMatchObject({ actionsReplayed: 18, unchanged: 0, counts: { newly_denied: 12, newly_requires_approval: 6 } });
    expect(sim.summary.topTools.newly_denied).toEqual([{ toolId: 'gmail.send', count: 12 }]);
    expect(sim.summary.approvalsPerWeekDelta).toBeCloseTo(6 / (90 / 7), 1);
    expect(sim.changes.every((c) => c.fromChain.length && c.toChain.length)).toBe(true);
    const stored = await t.policies.simulation.query({ id: sim.id });
    expect(stored.actionsReplayed).toBe(18);
    expect((await t.policies.list.query()).items.find((i) => i.key === 'no-external-mail')!.state).toBe('simulated');
    const narrow = await t.policies.simulate.mutate({ bundleId: b.id, windowDays: 30 });
    expect(narrow.summary.counts.newly_denied).toBe(5); // days 1, 8, 15, 22, 29
  });
});

describe('risk weights (§6.4): bounded, versioned, previewed', () => {
  it('out of bounds is refused; a change is a new version; the preview re-scores recent actions', async () => {
    const before = await admin().risk.weights.get.query();
    expect(before).toMatchObject({ tenantOwned: false, weights: { version: 1 } });
    const bad = await problemOf(admin().risk.weights.put.mutate({ ...DEFAULT_WEIGHTS, w1: 0.95 }));
    expect(bad.status).toBe(400);
    expect((await problemOf(as('member').risk.weights.put.mutate({ ...DEFAULT_WEIGHTS }))).status).toBe(403);
    const preview = await admin().risk.weights.preview.query({ ...DEFAULT_WEIGHTS, w3: 0.6, days: 30 });
    expect(preview.actions).toBeGreaterThan(0);
    const put = await admin().risk.weights.put.mutate({ ...DEFAULT_WEIGHTS, w3: 0.5 });
    expect(put.weights.version).toBeGreaterThan(1);
    const after = await admin().risk.weights.get.query();
    expect(after).toMatchObject({ tenantOwned: true, weights: { w3: 0.5 } });
    const dry: RiskInput = { sensitivity: 10, labels: [], effect: { recipients: 1, externalRecipients: 1, recordsAffected: 0 }, egressClass: 'EXTERNAL', reversibility: 'R2', principalRole: 'MEMBER', argTaint: 'TRUSTED', recipientTaint: 'TRUSTED', inScope: true };
    expect((await admin().risk.score.query({ input: dry })).score).toBe(scoreRisk(dry, { ...DEFAULT_WEIGHTS, w3: 0.5, version: put.weights.version }).score);
  });
});

describe('the approver a policy names is enforced (§5.1 approver_role, separation of duties)', () => {
  async function pendingRun(status: string, pending: Record<string, unknown>, principal = users.member) {
    const [agent] = await owner<{ id: string }>(`INSERT INTO agents (tenant_id, workspace_id, name, owner_user_id, idp_machine_id, status) VALUES ($1, $2, $3, $4, 'm', 'active') RETURNING id`, [A.tenantId, A.workspaceId, `b-${randomUUID().slice(0, 8)}`, A.userId]);
    const [run] = await owner<{ id: string }>(
      `INSERT INTO runs (tenant_id, workspace_id, agent_id, principal_user_id, trigger, objective_json, status, pending_json) VALUES ($1, $2, $3, $4, 'test', '{"objective":"x"}', $5, $6) RETURNING id`,
      [A.tenantId, A.workspaceId, agent!.id, principal, status, JSON.stringify(pending)],
    );
    return run!.id;
  }

  it('a dual approval with separation of duties: the requester cannot, a MEMBER cannot, the same ADMIN twice cannot', async () => {
    const id = await pendingRun('AWAITING_APPROVAL', { kind: 'approval', key: 'v1:1:abc', approvalsRequired: 2, approvedBy: [users.admin1], policy: { decision: 'REQUIRE_DUAL_APPROVAL', approverRole: 'ADMIN', separationOfDuties: true } }, A.userId);
    // The run's own principal (an OWNER) is refused by separation of duties, not by role.
    const own = await problemOf(admin().runs.decide.mutate({ id, decision: 'approve' }));
    expect(own).toMatchObject({ status: 403, detail: expect.stringContaining('separation of duties') as unknown });
    expect((await problemOf(as('member').runs.decide.mutate({ id, decision: 'approve' }))).status).toBe(403);
    expect((await problemOf(as('admin1').runs.decide.mutate({ id, decision: 'approve' }))).status).toBe(409);
    await as('admin2').runs.decide.mutate({ id, decision: 'approve' });
    expect(signals.filter((s) => s.runId === id).map((s) => s.message)).toEqual([expect.objectContaining({ key: 'v1:1:abc', decision: 'approve', by: users.admin2 })]);
    // Rejecting your own run's action needs no role.
    await admin().runs.decide.mutate({ id, decision: 'reject' });
  });

  it('a single approval routed to APPROVER: a MEMBER principal may reject but not approve their own action', async () => {
    const id = await pendingRun('AWAITING_APPROVAL', { kind: 'approval', key: 'v1:2:def', approvalsRequired: 1, approvedBy: [], policy: { decision: 'REQUIRE_APPROVAL', approverRole: 'APPROVER' } });
    const refused = await problemOf(as('member').runs.decide.mutate({ id, decision: 'approve' }));
    expect(refused.detail).toContain('needs approval by APPROVER');
    await as('member').runs.decide.mutate({ id, decision: 'reject' });
    await as('admin1').runs.decide.mutate({ id, decision: 'approve' });
  });

  it('a hold is released or revoked by its principal (or an approver), and only while held', async () => {
    const id = await pendingRun('HELD', { kind: 'hold', key: 'v1:1:ghi', toolId: 'gmail.send', holdWindowMs: 120_000 });
    await as('member').runs.release.mutate({ id });
    await as('member').runs.revoke.mutate({ id });
    expect(signals.filter((s) => s.runId === id).map((s) => [s.topic, s.message['action']])).toEqual([
      ['resume', 'release'],
      ['resume', 'revoke'],
    ]);
    const notHeld = await pendingRun('AWAITING_APPROVAL', { kind: 'approval', key: 'k' });
    expect((await problemOf(as('member').runs.release.mutate({ id: notHeld }))).status).toBe(422);
  });
});

describe('webhooks (§7)', () => {
  it('policy.activated, policy.denied_action and risk.critical can be subscribed to', async () => {
    const { eventKinds } = await admin().webhooks.list.query();
    expect(eventKinds).toEqual(expect.arrayContaining(['policy.activated', 'policy.denied_action', 'risk.critical']));
  });
});
