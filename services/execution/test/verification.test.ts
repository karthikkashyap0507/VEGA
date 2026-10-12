import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { launchRegistry } from '@vega/connectors';
import { FakeProviders } from '@vega/connector-testing';
import { DbosOrchestrator, type Hooks, type PolicyDecision, type StepContext } from '@vega/orchestration';
import type { RunStatus } from '@vega/contracts';
import { RUN_WORKFLOW, runWorkflow, type PendingAction } from '../src/executor/index.js';
import { ROLLBACK_WORKFLOW, rollbackWorkflow } from '../src/reversibility/index.js';
import { connect, dbosUrl, executorKit, objectiveFor, ownerQuery, plannedRun, seedTenant, setAgentSpec, waitFor, type ExecutorKit, type Tenant } from './fixtures.js';

/**
 * C6 VERIFICATION IN THE EXECUTOR (docs/module9.md §5, §12) against real Postgres, the real DBOS
 * engine and the provider fakes:
 *
 *   an unsupported price at HIGH tier → a person decides, with the claim in front of them
 *   a contradicted figure → ABORT → the run replans · a credential leaving → ABORT
 *   the same message twice in one run → ABORT · post-commit failure → COMPENSATED (BLOCKING)
 *   every verification is a row, with findings, and the run carries a summary
 */

vi.setConfig({ testTimeout: 60_000 });

const SYSTEM_DB = 'vega_dbos_verification_test';
const providers = new FakeProviders();
let decide: (ctx: StepContext) => Promise<PolicyDecision> = async () => ({ decision: 'ALLOW' });
/** Post-commit tamper: narrow what the engine believes was simulated/approved. */
let narrow: ((ctx: StepContext) => boolean) | null = null;
let kit: ExecutorKit;
let orchestrator: DbosOrchestrator;
let t: Tenant;
let bindings: Record<string, string>;

beforeAll(async () => {
  await ownerQuery(`DROP DATABASE IF EXISTS ${SYSTEM_DB} WITH (FORCE)`);
  kit = await executorKit(providers.fetch, {
    policy: (ctx) => decide(ctx),
    reversibility: true,
    hooks: (h: Hooks): Hooks => ({
      ...h,
      verify: (ctx, r) =>
        h.verify(ctx, narrow?.(ctx) && r.input?.sim.ok ? { ...r, input: { ...r.input, sim: { ok: true, effect: { ...r.input.sim.effect, externalRecipients: [] } } } } : r),
    }),
  });
  orchestrator = new DbosOrchestrator({ appName: 'vega-verification-test', systemDatabaseUrl: dbosUrl(SYSTEM_DB), logLevel: 'error' });
  orchestrator.register(RUN_WORKFLOW, runWorkflow(kit.deps));
  orchestrator.register(ROLLBACK_WORKFLOW, rollbackWorkflow(kit.engine!));
  await orchestrator.launch();
  t = await seedTenant();
  await setAgentSpec(t, 1, { allowedTools: launchRegistry().records().map((r) => r.toolId) });
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
const send = (to: string, subject: string, body: string) => `call gmail.send({ to: ["${to}"], subject: "${subject}", body: "${body}" })`;
const verifications = (runId: string) =>
  ownerQuery<{ id: string; phase: string; outcome: string; failed_check: string | null; checks_json: Array<{ check: string; outcome: string; detail: string }> }>(`SELECT * FROM verifications WHERE run_id = $1 ORDER BY created_at`, [runId]);
const high = async (): Promise<PolicyDecision> => ({ decision: 'ALLOW', riskTier: 'HIGH', riskScore: 70 });

describe('groundedness (§5.2): what no trusted source supports is put in front of a person', () => {
  it('an unsupported price at HIGH tier waits for approval, the claim highlighted; approved, it runs', async () => {
    decide = high;
    const objective = objectiveFor(t, 'Tell Dana the renewal covers 40 seats.');
    const { runId } = await plannedRun(kit, t, `${send('dana@partner.example', 'Renewal', 'Your renewal covers 40 seats at $9,999 per year.')}\nemit "ok"`, { bindings, objective });
    await start(runId);
    const waiting = await until(runId, ['AWAITING_APPROVAL', 'FAILED', 'COMPLETED']);
    expect(waiting.status).toBe('AWAITING_APPROVAL');
    const pending = waiting.pending as PendingAction;
    expect(pending.reason).toMatch(/^verification: groundedness: 1 of 2 claims unsupported/);
    expect(pending.verification!.unsupportedClaims).toEqual([{ text: '$9,999', reason: 'no trusted source supports this price' }]);
    expect(pending.verification!.checks.map((c) => [c.check, c.outcome])).toEqual([
      ['permissions', 'PASS'],
      ['policy', 'PASS'],
      ['conflicts', 'PASS'],
      ['exposure', 'PASS'],
      ['consequence', 'PASS'],
      ['groundedness', 'ESCALATE'],
    ]);
    const [v1] = await verifications(runId);
    expect(v1).toMatchObject({ phase: 'pre_commit', outcome: 'ESCALATE', failed_check: 'groundedness' });
    const findings = await ownerQuery<{ claim_text: string; claim_kind: string; verdict: string; severity: string; source_ids: string[] }>(`SELECT * FROM groundedness_findings WHERE verification_id = $1 ORDER BY claim_text`, [v1!.id]);
    expect(findings.map((f) => [f.claim_text, f.verdict, f.severity])).toEqual([
      ['$9,999', 'UNSUPPORTED', 'BLOCK'],
      ['40', 'SUPPORTED', 'INFO'],
    ]);
    expect(findings[1]!.source_ids).toEqual([`objective:${runId}`]);

    await orchestrator.send(runId, 'decision', { key: pending.key, decision: 'approve', by: t.userId });
    await until(runId, ['COMPLETED']);
    const all = await verifications(runId);
    expect(all.map((v) => [v.phase, v.outcome])).toEqual([
      ['pre_commit', 'ESCALATE'],
      ['pre_commit', 'WARN'], // approved with the finding in front of them: a warning on the record
      ['post_commit', 'PASS'],
    ]);
    expect(providers.google.sent.filter((m) => JSON.stringify(m).includes('$9,999'))).toHaveLength(1);
    const [run] = await ownerQuery<{ verification_summary: Record<string, unknown> }>(`SELECT verification_summary FROM runs WHERE id = $1`, [runId]);
    expect(run!.verification_summary).toMatchObject({ verifications: 3, escalate: 1, warn: 1, pass: 1, unsupportedClaims: 2 });
  });

  it('a figure the sources contradict is not sent: ABORT, and the run replans', async () => {
    decide = high;
    const objective = objectiveFor(t, 'Remind Sam that the nightly hotel cap in Berlin is 180 EUR.');
    const { runId } = await plannedRun(kit, t, `${send('sam@partner.example', 'Hotel cap', 'Reminder: the hotel cap in Berlin is 250 EUR per night.')}\nemit "ok"`, { bindings, objective });
    await start(runId);
    const v = await until(runId, ['REPLANNING', 'FAILED', 'COMPLETED', 'AWAITING_APPROVAL']);
    expect(v.status).toBe('REPLANNING');
    const [ver] = await verifications(runId);
    expect(ver).toMatchObject({ outcome: 'ABORT', failed_check: 'groundedness' });
    expect(ver!.checks_json.find((c) => c.check === 'groundedness')!.detail).toMatch(/contradicted.*the sources say otherwise/);
    const [node] = await ownerQuery<{ status: string; error_json: { code: string } }>(`SELECT status, error_json FROM task_nodes WHERE run_id = $1 AND tool_id = 'gmail.send'`, [runId]);
    expect(node).toMatchObject({ status: 'failed', error_json: { code: 'VERIFICATION_FAILED' } });
    expect(providers.google.sent.some((m) => JSON.stringify(m).includes('250 EUR'))).toBe(false);
  });
});

describe('exposure and conflicts (§5.1)', () => {
  it('a credential is never sent outside the organization', async () => {
    decide = async () => ({ decision: 'ALLOW', riskTier: 'LOW' });
    const { runId } = await plannedRun(kit, t, `${send('vendor@partner.example', 'Access', 'Use key AKIAABCDEFGHIJKLMNOP to log in.')}\nemit "ok"`, { bindings });
    await start(runId);
    expect((await until(runId, ['REPLANNING', 'FAILED', 'COMPLETED'])).status).toBe('REPLANNING');
    const [ver] = await verifications(runId);
    expect(ver).toMatchObject({ outcome: 'ABORT', failed_check: 'exposure' });
    expect(ver!.checks_json.map((c) => c.outcome)).toEqual(['PASS', 'PASS', 'PASS', 'ABORT', 'SKIPPED', 'SKIPPED']);
  });

  it('the same message twice in one run is a loop: the second is stopped', async () => {
    decide = async () => ({ decision: 'ALLOW', riskTier: 'LOW' });
    const msg = send('lee@partner.example', 'Loop check', 'Checking in about the loop test.');
    const { runId } = await plannedRun(kit, t, `${msg}\n${msg}\nemit "ok"`, { bindings });
    await start(runId);
    expect((await until(runId, ['REPLANNING', 'FAILED', 'COMPLETED'])).status).toBe('REPLANNING');
    const vs = await verifications(runId);
    expect(vs.map((v) => [v.phase, v.outcome, v.failed_check])).toEqual([
      ['pre_commit', 'WARN', null], // an unsourced sentence: groundedness warns, never blocks a fact
      ['post_commit', 'PASS', null],
      ['pre_commit', 'ABORT', 'conflicts'],
    ]);
    expect(vs[2]!.checks_json.find((c) => c.check === 'conflicts')!.detail).toMatch(/already sent .* by this run/);
  });

  it('a read is checked for permissions and policy only', async () => {
    decide = async () => ({ decision: 'ALLOW', riskTier: 'LOW' });
    const { runId } = await plannedRun(kit, t, `let m = call gmail.search({ query: "renewal" })\nemit "ok"`, { bindings });
    await start(runId);
    await until(runId, ['COMPLETED']);
    const [ver] = await verifications(runId);
    expect(ver!.checks_json.map((c) => c.check)).toEqual(['permissions', 'policy']);
  });
});

describe('★ post-commit failure → compensation (§5.3, BLOCKING)', () => {
  it('an action that reached someone nobody approved is undone, and the run says why', async () => {
    decide = async () => ({ decision: 'ALLOW', riskTier: 'LOW' });
    narrow = (ctx) => ctx.toolId === 'gcal.create';
    try {
      const { runId } = await plannedRun(kit, t, `call gcal.create({ summary: "Verify me", start: "2026-11-03T09:00:00Z", end: "2026-11-03T09:30:00Z", attendees: ["guest@partner.example"] })\nemit "ok"`, { bindings });
      await start(runId);
      const v = await until(runId, ['COMPENSATED', 'COMPENSATION_FAILED', 'FAILED', 'COMPLETED']);
      expect(v.status).toBe('COMPENSATED');
      expect(v.statusReason).toMatch(/verification failed for gcal.create after it ran: consequence: the action reached guest@partner.example/);
      const vs = await verifications(runId);
      expect(vs.at(-1)).toMatchObject({ phase: 'post_commit', outcome: 'COMPENSATE', failed_check: 'consequence' });
      expect((await ownerQuery<{ trigger: string }>(`SELECT trigger FROM rollbacks WHERE run_id = $1`, [runId]))[0]!.trigger).toBe('verification');
      expect(providers.google.events(t.email).filter((e) => e.summary === 'Verify me' && e.status !== 'cancelled')).toEqual([]);
    } finally {
      narrow = null;
    }
  });
});
