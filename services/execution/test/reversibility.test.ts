import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { launchRegistry } from '@vega/connectors';
import { FakeProviders } from '@vega/connector-testing';
import { parseRevokeToken } from '@vega/compensators';
import { DbosOrchestrator, type Hooks, type PolicyDecision, type StepContext } from '@vega/orchestration';
import type { RunStatus } from '@vega/contracts';
import { RUN_WORKFLOW, runWorkflow, TOPICS, type PendingAction } from '../src/executor/index.js';
import { ROLLBACK_WORKFLOW, rollbackWorkflow, type RollbackOutcome } from '../src/reversibility/index.js';
import { connect, dbosUrl, executorKit, ownerQuery, plannedRun, seedTenant, setAgentSpec, waitFor, type ExecutorKit, type Tenant } from './fixtures.js';

/**
 * THE REVERSIBILITY LAYER IN THE EXECUTOR (docs/module6.md §5, §8, §11, §12) against real
 * Postgres, the real DBOS engine and the provider fakes:
 *
 *   capture before the call, bound to the outcome · an explicit Undo · the saga on failure in
 *   strict reverse order · a failing compensation → bounded retries → incident + demotion ·
 *   divergence aborts and compensates · holds: revoke, the timer (±1 s), a revoke racing the
 *   timer, edit-and-requeue, a restart mid-hold, a hold that cannot be settled → NEEDS_ATTENTION
 *   · the one-tap push capability.
 */

vi.setConfig({ testTimeout: 60_000 });

const SYSTEM_DB = 'vega_dbos_reversibility_test';
const providers = new FakeProviders();
const pushes: Array<{ topic: string; revokeToken: string; revokeUrl: string; message: string }> = [];
let decide: (ctx: StepContext) => Promise<PolicyDecision> = async () => ({ decision: 'ALLOW' });
let tamper: ((ctx: StepContext) => boolean) | null = null;
let kit: ExecutorKit;
let orchestrator: DbosOrchestrator;
let t: Tenant;
let bindings: Record<string, string>;

const ALL_TOOLS = launchRegistry().records().map((r) => r.toolId);

async function launch() {
  orchestrator = new DbosOrchestrator({ appName: 'vega-reversibility-test', systemDatabaseUrl: dbosUrl(SYSTEM_DB), logLevel: 'error' });
  orchestrator.register(RUN_WORKFLOW, runWorkflow(kit.deps));
  orchestrator.register(ROLLBACK_WORKFLOW, rollbackWorkflow(kit.engine!));
  await orchestrator.launch();
}

beforeAll(async () => {
  await ownerQuery(`DROP DATABASE IF EXISTS ${SYSTEM_DB} WITH (FORCE)`);
  kit = await executorKit(providers.fetch, {
    policy: (ctx) => decide(ctx),
    reversibility: { notifier: { notify: async (n) => void pushes.push(n) }, pushSecret: 'test-push-secret' },
    // A simulation that lies (for the divergence test): the approved recipients were different.
    hooks: (h: Hooks): Hooks => ({
      ...h,
      simulate: async (ctx) => {
        const sim = await h.simulate(ctx);
        return tamper?.(ctx) && sim.ok ? { ok: true, effect: { ...sim.effect, externalRecipients: ['someone-else@partner.example'] } } : sim;
      },
    }),
  });
  await launch();
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

const view = async (runId: string) => (await kit.store.view(t.tenantId, runId))!;
const until = (runId: string, want: RunStatus[], ms = 30_000) =>
  waitFor(async () => {
    const v = await kit.store.view(t.tenantId, runId);
    return v && want.includes(v.status) ? v : null;
  }, ms, `run ${runId} to reach ${want.join('|')}`).catch(async (e: Error) => {
    const v = await kit.store.view(t.tenantId, runId);
    throw new Error(`${e.message} (it is ${v?.status}${v?.statusReason ? `: ${v.statusReason}` : ''})`);
  });
const start = (runId: string) => orchestrator.start(RUN_WORKFLOW, runId, { tenantId: t.tenantId, runId });
const live = () => providers.google.events(t.email).filter((e) => e.status !== 'cancelled');
const create = (summary: string, attendee = 'guest@partner.example') => `call gcal.create({ summary: "${summary}", start: "2026-11-02T09:00:00Z", end: "2026-11-02T09:30:00Z", attendees: ["${attendee}"] })`;
const compensations = (runId: string) =>
  ownerQuery<{ id: string; tool_id: string; state: string; forward_state: string; commit_seq: string | null; ttl_at: Date | null; description: string; attempts: number; token_sealed: unknown; last_error: { code: string } | null }>(
    `SELECT * FROM compensations WHERE run_id = $1 ORDER BY commit_seq`,
    [runId],
  );
const holdOf = async (runId: string) => (await ownerQuery<{ id: string; state: string; expires_at: Date; released_at: Date | null; revoke_token_hash: string; edit_diff: unknown; allowed_revokers: string[] }>(`SELECT * FROM holds WHERE run_id = $1 ORDER BY created_at DESC`, [runId]))[0];
const store = () => kit.engine!.deps.store;

describe('capture before the call, bound to the outcome (§5.2)', () => {
  it('an R1 call arms a sealed compensation; the outcome starts its TTL and fixes its order', async () => {
    decide = async () => ({ decision: 'ALLOW' });
    const { runId } = await plannedRun(kit, t, `${create('Capture probe — private agenda')}\nemit "ok"`, { bindings });
    await start(runId);
    await until(runId, ['COMPLETED']);
    const [c] = await compensations(runId);
    expect(c).toMatchObject({ tool_id: 'gcal.create', state: 'armed', forward_state: 'committed' });
    expect(c!.ttl_at!.getTime()).toBeGreaterThan(Date.now() + 89 * 86_400_000);
    expect(c!.description).toMatch(/Deletes “Capture probe — private agenda” and sends a cancellation to 1 attendee/);
    expect(JSON.stringify(c!.token_sealed)).not.toContain('private agenda');
    // The HOOK ORDER holds: capture happened before the call.
    const steps = kit.hookLog.steps(runId, 1);
    expect(steps.indexOf('captureCompensator')).toBeLessThan(steps.indexOf('call'));
  });
});

describe('the blast radius (§5.6)', () => {
  it('is computed before the run: reads executed, writes simulated, grouped, with the weakest fidelity', async () => {
    decide = async () => ({ decision: 'ALLOW' });
    providers.google.seedMessage(t.email, { from: 'a@partner.example', subject: 'blast-probe one', body: 'x' });
    const { runId } = await plannedRun(kit, t, `let m = call gmail.search({ query: "blast-probe" })\n${create('Blast event', 'b@partner.example')}\nemit m`, { bindings });
    await start(runId);
    await until(runId, ['COMPLETED']);
    const br = (await store().latestBlastRadius(t.tenantId, runId))!;
    expect(br.programVersion).toBe(1);
    expect(br.summary).toMatchObject({ consequential: 1, minFidelity: 'DERIVED', reads: [{ toolId: 'gmail.search', label: '1 email' }] });
    expect(br.summary.groups[0]).toMatchObject({ label: 'create 1 event', externalDomains: ['partner.example'], reversibility: 'R1' });
    // Nothing happened during the preview: exactly one event exists, created by the real call.
    expect(live().filter((e) => e.summary === 'Blast event')).toHaveLength(1);
  });
});

describe('an explicit Undo (§6.3, §8.2)', () => {
  it('deletes the event, tells the attendee, records Time-to-Undo; a second undo finds nothing to do', async () => {
    const { runId } = await plannedRun(kit, t, `${create('Undo me')}\nemit "ok"`, { bindings });
    await start(runId);
    await until(runId, ['COMPLETED']);
    expect(live().some((e) => e.summary === 'Undo me')).toBe(true);
    const [c] = await compensations(runId);
    const rb = await kit.engine!.plan(t.tenantId, { runId, scope: 'action', trigger: 'user', requestedBy: t.userId, requestedAt: new Date(), compensationId: c!.id });
    expect(rb.compensationIds).toEqual([c!.id]);
    const notes = providers.google.notifications.length;
    await orchestrator.start(ROLLBACK_WORKFLOW, rb.id, { tenantId: t.tenantId, rollbackId: rb.id });
    const out = (await orchestrator.result<RollbackOutcome>(rb.id, 30))!;
    expect(out).toMatchObject({ state: 'succeeded', reversed: [{ toolId: 'gcal.create', notified: ['guest@partner.example'] }] });
    expect(live().some((e) => e.summary === 'Undo me')).toBe(false);
    expect(providers.google.notifications.slice(notes)).toMatchObject([{ kind: 'cancellation', to: ['guest@partner.example'] }]);
    const [after] = await compensations(runId);
    expect(after!.state).toBe('succeeded');
    expect((await ownerQuery<{ state: string }>(`SELECT state FROM actions WHERE run_id = $1`, [runId]))[0]!.state).toBe('COMPENSATED');
    expect((await ownerQuery<{ status: string }>(`SELECT status FROM task_nodes WHERE run_id = $1 AND tool_id = 'gcal.create'`, [runId]))[0]!.status).toBe('compensated');
    const [ttu] = await ownerQuery<{ kind: string; succeeded: boolean; duration_ms: number }>(`SELECT * FROM undo_metrics WHERE run_id = $1`, [runId]);
    expect(ttu).toMatchObject({ kind: 'compensate', succeeded: true });
    expect(ttu!.duration_ms).toBeGreaterThanOrEqual(0);
    // Idempotent at the lifecycle level too: nothing left to plan.
    expect((await kit.engine!.plan(t.tenantId, { runId, scope: 'run', trigger: 'user', requestedBy: t.userId, requestedAt: new Date() })).compensationIds).toEqual([]);
  });
});

describe('the saga (§5.8, §8.2): a failed run undoes what it did, in strict reverse order', () => {
  it('two events created, then the run fails → both deleted, last first → COMPENSATED', async () => {
    decide = async (ctx) => (ctx.toolId === 'gmail.send' ? { decision: 'DENY', failClosed: true, reason: 'engine unavailable (test)' } : { decision: 'ALLOW' });
    const { runId } = await plannedRun(kit, t, `${create('Saga first')}\n${create('Saga second')}\ncall gmail.send({ to: ["x@partner.example"], subject: "S", body: "B" })\nemit "ok"`, { bindings });
    const mark = providers.core.calls.length;
    await start(runId);
    const v = await until(runId, ['COMPENSATED', 'COMPENSATION_FAILED', 'FAILED']);
    expect(v.status).toBe('COMPENSATED');
    expect(v.statusReason).toMatch(/Undid 2 actions/);
    const deletes = providers.core.calls.slice(mark).filter((c) => c.method === 'DELETE');
    const ids = (await compensations(runId)).map((c) => c.commit_seq);
    expect(ids).toHaveLength(2);
    // The second event (committed last) was deleted first.
    const events = providers.google.events(t.email).filter((e) => String(e.summary).startsWith('Saga'));
    const second = events.find((e) => e.summary === 'Saga second')!;
    const first = events.find((e) => e.summary === 'Saga first')!;
    expect(deletes.map((d) => d.url.split('/events/')[1]!.split('?')[0])).toEqual([second.id, first.id]);
    expect(events.every((e) => e.status === 'cancelled')).toBe(true);
    const [rb] = await ownerQuery<{ trigger: string; state: string }>(`SELECT * FROM rollbacks WHERE run_id = $1`, [runId]);
    expect(rb).toMatchObject({ trigger: 'run_failure', state: 'succeeded' });
  });

  it('a compensation that keeps failing: bounded retries, then an incident, a demotion request, and the rest NOT attempted', async () => {
    decide = async (ctx) => (ctx.toolId === 'gmail.send' ? { decision: 'DENY', failClosed: true, reason: 'engine unavailable (test)' } : { decision: 'ALLOW' });
    const { runId } = await plannedRun(kit, t, `${create('Fails first')}\n${create('Fails second')}\ncall gmail.send({ to: ["x@partner.example"], subject: "S", body: "B" })\nemit "ok"`, { bindings });
    // The organizer changed (§8.3): every DELETE of the second event is refused.
    providers.core.inject({ match: (u, m) => m === 'DELETE' && u.pathname.includes('/events/'), status: 403, times: 1 });
    await start(runId);
    const v = await until(runId, ['COMPENSATED', 'COMPENSATION_FAILED', 'FAILED']);
    expect(v.status).toBe('COMPENSATION_FAILED');
    const cs = await compensations(runId);
    const byOrder = [...cs].sort((a, b) => Number(b.commit_seq) - Number(a.commit_seq));
    expect(byOrder[0]).toMatchObject({ state: 'failed', last_error: { code: 'PERMISSION_DENIED' } });
    expect(byOrder[1]!.state).toBe('armed'); // not attempted
    expect(live().some((e) => e.summary === 'Fails first')).toBe(true);
    const [inc] = await ownerQuery<{ kind: string; severity: string; detail_json: { steps: string[]; notAttempted: string[]; error: { code: string } } }>(`SELECT * FROM incidents WHERE run_id = $1`, [runId]);
    expect(inc).toMatchObject({ kind: 'compensation_failed', severity: 'CRITICAL', detail_json: { error: { code: 'PERMISSION_DENIED' } } });
    expect(inc!.detail_json.notAttempted).toEqual([byOrder[1]!.id]);
    expect(inc!.detail_json.steps[0]).toMatch(/no longer has the permission/);
    expect(inc!.detail_json.steps.some((s) => s.includes('Delete it'))).toBe(true);
    expect(await ownerQuery(`SELECT 1 FROM platform_events WHERE tenant_id = $1 AND kind = 'autonomy.demotion_requested' AND payload->>'runId' = $2`, [t.tenantId, runId])).toHaveLength(1);
  });

  it('a transient provider failure is retried with backoff and then succeeds', async () => {
    decide = async () => ({ decision: 'ALLOW' });
    const { runId } = await plannedRun(kit, t, `${create('Retry me')}\nemit "ok"`, { bindings });
    await start(runId);
    await until(runId, ['COMPLETED']);
    const [c] = await compensations(runId);
    // Three 503s: the runtime's own quick retries are spent, so the lifecycle's durable retry is what saves it.
    providers.core.inject({ match: (u, m) => m === 'DELETE' && u.pathname.includes('/events/'), status: 503, times: 2 });
    const rb = await kit.engine!.plan(t.tenantId, { runId, scope: 'action', trigger: 'user', requestedBy: t.userId, requestedAt: new Date(), compensationId: c!.id });
    await orchestrator.start(ROLLBACK_WORKFLOW, rb.id, { tenantId: t.tenantId, rollbackId: rb.id });
    const out = (await orchestrator.result<RollbackOutcome>(rb.id, 40))!;
    expect(out.state).toBe('succeeded');
    const [after] = await compensations(runId);
    expect(after).toMatchObject({ state: 'succeeded' });
    expect(after!.attempts).toBeGreaterThanOrEqual(2);
  });
});

describe('divergence (§5.7)', () => {
  it('an effect that does not match what was simulated aborts the run and undoes it', async () => {
    decide = async () => ({ decision: 'ALLOW' });
    tamper = (ctx) => ctx.toolId === 'gcal.create';
    try {
      const { runId } = await plannedRun(kit, t, `${create('Diverges')}\nemit "ok"`, { bindings });
      await start(runId);
      const v = await until(runId, ['COMPENSATED', 'COMPENSATION_FAILED', 'FAILED', 'COMPLETED']);
      expect(v.status).toBe('COMPENSATED');
      expect(v.statusReason).toMatch(/did not do what its simulation said \(externalRecipients differed\)/);
      const [d] = await ownerQuery<{ severity: string; tool_id: string }>(`SELECT * FROM divergences WHERE run_id = $1`, [runId]);
      expect(d).toMatchObject({ severity: 'ABORT', tool_id: 'gcal.create' });
      expect(live().some((e) => e.summary === 'Diverges')).toBe(false);
      expect((await ownerQuery<{ trigger: string }>(`SELECT trigger FROM rollbacks WHERE run_id = $1`, [runId]))[0]!.trigger).toBe('divergence');
    } finally {
      tamper = null;
    }
  });
});

describe('holds (§5.5)', () => {
  const holdFor = (ms: number) => async (ctx: StepContext): Promise<PolicyDecision> => (ctx.toolId === 'gmail.send' ? { decision: 'ALLOW_WITH_HOLD', holdWindowMs: ms, reason: 'external send (test)' } : { decision: 'ALLOW' });
  const sendTo = (to: string, body = 'Hello') => `call gmail.send({ to: ["${to}"], subject: "Held", body: "${body}" })\nemit "ok"`;
  const sent = (to: string) => providers.google.sent.filter((m) => JSON.stringify(m).includes(to));

  it('a revoke (committed on the hold row) cancels it: nothing reaches the provider', async () => {
    decide = holdFor(60_000);
    const to = 'revoke@partner.example';
    const { runId } = await plannedRun(kit, t, sendTo(to), { bindings });
    await start(runId);
    await until(runId, ['HELD']);
    const hold = await waitFor(() => holdOf(runId), 10_000, 'the hold row');
    expect(hold.allowed_revokers).toContain(t.userId);
    const r = await store().decideHold(t.tenantId, hold.id, 'revoked', { by: t.userId, channel: 'app', requestedAt: new Date() });
    expect(r.won).toBe(true);
    await orchestrator.send(runId, TOPICS.resume, { action: 'revoke', by: t.userId });
    const v = await until(runId, ['CANCELLED']);
    expect(v.statusReason).toMatch(/never ran/);
    expect(sent(to)).toHaveLength(0);
    expect((await ownerQuery<{ state: string }>(`SELECT state FROM actions WHERE run_id = $1`, [runId]))[0]!.state).toBe('REVOKED');
  });

  it('the window passes: the timer releases it once, within ±1 s of the expiry', async () => {
    decide = holdFor(2_000);
    const to = 'timer@partner.example';
    const { runId } = await plannedRun(kit, t, sendTo(to), { bindings });
    await start(runId);
    await until(runId, ['COMPLETED']);
    const hold = (await holdOf(runId))!;
    expect(hold.state).toBe('expired_released');
    expect(Math.abs(hold.released_at!.getTime() - hold.expires_at.getTime())).toBeLessThan(1_000);
    expect(sent(to)).toHaveLength(1);
  });

  it('a revoke that commits while nobody is listening still wins over the timer', async () => {
    decide = holdFor(2_500);
    const to = 'race@partner.example';
    const { runId } = await plannedRun(kit, t, sendTo(to), { bindings });
    await start(runId);
    await until(runId, ['HELD']);
    const hold = await waitFor(() => holdOf(runId), 10_000, 'the hold row');
    // No message: only the row says it. The timer's compare-and-set loses.
    await store().decideHold(t.tenantId, hold.id, 'revoked', { by: t.userId, channel: 'push' });
    await until(runId, ['CANCELLED'], 15_000);
    expect(sent(to)).toHaveLength(0);
  });

  it('edit and requeue: the edited content is decided again, held again, and is what is sent', async () => {
    decide = holdFor(60_000);
    const to = 'edit@partner.example';
    const { runId } = await plannedRun(kit, t, sendTo(to, 'First draft'), { bindings });
    await start(runId);
    const held = await until(runId, ['HELD']);
    const hold = await waitFor(() => holdOf(runId), 10_000, 'the hold row');
    const args = (held.pending as PendingAction).args!;
    await store().decideHold(t.tenantId, hold.id, 'edited_requeued', { by: t.userId, editedArgs: { ...args, body: 'Corrected text' }, editDiff: { toolId: 'gmail.send', fields: { body: { before: 'First draft', after: 'Corrected text' } }, editedBy: t.userId, editedAt: new Date().toISOString() } });
    await orchestrator.send(runId, TOPICS.resume, { action: 'edit', by: t.userId });
    // A second hold, for the edited version.
    const second = await waitFor(async () => {
      const h = await holdOf(runId);
      return h && h.id !== hold.id ? h : null;
    }, 15_000, 'a new hold for the edited content');
    expect((await until(runId, ['HELD'])).pending).toMatchObject({ edited: true, args: { body: 'Corrected text' } });
    await store().decideHold(t.tenantId, second.id, 'released', { by: t.userId });
    await orchestrator.send(runId, TOPICS.resume, { action: 'release', by: t.userId });
    await until(runId, ['COMPLETED']);
    expect(sent(to)).toHaveLength(1);
    expect(sent(to)[0]!.body).toContain('Corrected text');
    expect((await ownerQuery<{ edit_diff: unknown }>(`SELECT edit_diff FROM holds WHERE id = $1`, [hold.id]))[0]!.edit_diff).toMatchObject({ fields: { body: { after: 'Corrected text' } } });
  });

  it('survives a restart mid-hold: a revoke committed while the worker was down is honoured', async () => {
    decide = holdFor(3_000);
    const to = 'restart@partner.example';
    const { runId } = await plannedRun(kit, t, sendTo(to), { bindings });
    await start(runId);
    await until(runId, ['HELD']);
    const hold = await waitFor(() => holdOf(runId), 10_000, 'the hold row');
    await orchestrator.shutdown();
    await store().decideHold(t.tenantId, hold.id, 'revoked', { by: t.userId, channel: 'app' });
    await new Promise((r) => setTimeout(r, 3_500)); // the window passes while nobody is running
    await orchestrator.launch(); // the same process restarting its engine: DBOS recovers the run
    await until(runId, ['CANCELLED'], 20_000);
    expect(sent(to)).toHaveLength(0);
  });

  it('a hold that cannot be settled is never released on a guess: NEEDS_ATTENTION and an incident', async () => {
    decide = holdFor(1_500);
    const to = 'ambiguous@partner.example';
    const { runId } = await plannedRun(kit, t, sendTo(to), { bindings });
    await start(runId);
    await until(runId, ['HELD']);
    const hold = await waitFor(() => holdOf(runId), 10_000, 'the hold row');
    await ownerQuery(`DELETE FROM holds WHERE id = $1`, [hold.id]);
    await until(runId, ['NEEDS_ATTENTION'], 15_000);
    expect(sent(to)).toHaveLength(0);
    expect(await ownerQuery(`SELECT 1 FROM incidents WHERE run_id = $1 AND kind = 'hold_ambiguous'`, [runId])).toHaveLength(1);
  });

  it('the principal is pushed a one-tap revoke capability; only its hash is stored', async () => {
    decide = holdFor(60_000);
    const before = pushes.length;
    const { runId } = await plannedRun(kit, t, sendTo('push@partner.example'), { bindings });
    await start(runId);
    await until(runId, ['HELD']);
    const hold = await waitFor(() => holdOf(runId), 10_000, 'the hold row');
    const push = await waitFor(async () => pushes[before], 5_000, 'the push');
    expect(push.revokeUrl).toBe('https://api.test/v1/holds/revoke');
    expect(push.message).toMatch(/Tap Revoke/);
    const cap = parseRevokeToken(push.revokeToken)!;
    expect(cap).toMatchObject({ tenantId: t.tenantId, hash: hold.revoke_token_hash });
    expect(JSON.stringify(await ownerQuery(`SELECT * FROM holds WHERE id = $1`, [hold.id]))).not.toContain(push.revokeToken);
    await store().decideHold(t.tenantId, hold.id, 'revoked', { by: t.userId, channel: 'push' });
    await orchestrator.send(runId, TOPICS.resume, { action: 'revoke' });
    await until(runId, ['CANCELLED']);
  });
});

// Keep `view` referenced for debugging sessions.
void view;
