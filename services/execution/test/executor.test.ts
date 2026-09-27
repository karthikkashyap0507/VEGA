import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { argsDigest, idempotencyKeyFor, PgInvocationStore } from '@vega/connector-sdk';
import { launchRegistry } from '@vega/connectors';
import { FakeProviders } from '@vega/connector-testing';
import { DbosOrchestrator, HOOK_ORDER } from '@vega/orchestration';
import type { RunStatus } from '@vega/contracts';
import { registerRunApi, RUN_WORKFLOW, runWorkflow, type PendingAction } from '../src/executor/index.js';
import { connect, dbosUrl, executorKit, objectiveFor, ownerQuery, plannedRun, savePlan, seedTenant, setAgentSpec, silent, waitFor, type ExecutorKit, type Tenant } from './fixtures.js';

/**
 * THE DURABLE EXECUTOR against real Postgres, the real DBOS engine, the real connector runtime
 * (idempotency ledger included) and the provider fakes. docs/module4.md §11: hook ordering,
 * at-most-once for R2/R3, replan correctness, limits — all blocking.
 */

// Real Postgres + DBOS: the 5 s default is too tight when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 });

const SYSTEM_DB = 'vega_dbos_executor_test';
const providers = new FakeProviders();
let kit: ExecutorKit;
let orchestrator: DbosOrchestrator;
let t: Tenant;
let gmail: string;
let gcal: string;
let bindings: Record<string, string>;
let extractions = 0;

const ALL_TOOLS = launchRegistry().records().map((r) => r.toolId);

beforeAll(async () => {
  await ownerQuery(`DROP DATABASE IF EXISTS ${SYSTEM_DB} WITH (FORCE)`);
  kit = await executorKit(providers.fetch);
  const inner = kit.deps.extractor;
  kit.deps.extractor = { extract: async (i) => (extractions++, inner.extract(i)) };
  orchestrator = new DbosOrchestrator({ appName: 'vega-executor-test', systemDatabaseUrl: dbosUrl(SYSTEM_DB), logLevel: 'error' });
  orchestrator.register(RUN_WORKFLOW, runWorkflow(kit.deps));
  await orchestrator.launch();
  t = await seedTenant();
  await setAgentSpec(t, 1, { allowedTools: ALL_TOOLS });
  gmail = await connect(t, 'gmail', (s) => providers.grant('google', t.email, s));
  gcal = await connect(t, 'gcal', (s) => providers.grant('google', t.email, s));
  bindings = { gmail, gcal };
}, 60_000);

afterAll(async () => {
  await orchestrator?.shutdown();
});

const status = async (runId: string) => (await kit.store.view(t.tenantId, runId))!.status;
const until = (runId: string, ...want: RunStatus[]) =>
  waitFor(async () => {
    const v = await kit.store.view(t.tenantId, runId);
    return v && want.includes(v.status) ? v : null;
  }, 30_000, `run ${runId} to reach ${want.join('|')}`);
const start = async (runId: string) => orchestrator.start(RUN_WORKFLOW, runId, { tenantId: t.tenantId, runId });
const sentTo = (addr: string) => providers.google.sent.filter((m) => JSON.stringify(m).includes(addr)).length;
const listCalls = () => providers.core.calls.filter((c) => c.method === 'GET' && /\/gmail\/v1\/users\/me\/messages\?/.test(c.url)).length;

describe('hook ordering (blocking)', () => {
  it('an action runs policy → simulate → approval → receipt:pre → capture → CALL → verify → receipt:post', async () => {
    const to = `colleague-order@${t.domain}`;
    let receiptBeforeEffect = false;
    kit.onExecute = async (i) => {
      const rows = await ownerQuery(`SELECT 1 FROM platform_events WHERE kind = 'action.receipt.pre' AND payload->>'runId' = $1 AND (payload->>'callSeq')::int = $2`, [i.runId, Number(i.nodeId.split('.')[1])]);
      receiptBeforeEffect = rows.length === 1;
    };
    const { runId } = await plannedRun(kit, t, `call gmail.send({ to: ["${to}"], subject: "Hello", body: "Plain text" })\nemit "sent"`, { bindings });
    await start(runId);
    await until(runId, 'COMPLETED');
    kit.onExecute = undefined;
    expect(kit.hookLog.steps(runId, 1)).toEqual([...HOOK_ORDER]);
    expect(receiptBeforeEffect).toBe(true);
    expect(sentTo(to)).toBe(1);
    const [action] = await kit.store.actions(t.tenantId, runId);
    expect(action).toMatchObject({ toolId: 'gmail.send', state: 'COMMITTED', reversibility: 'R2' });
    const nodes = await kit.store.nodes(t.tenantId, runId);
    expect(nodes.find((n) => n.toolId === 'gmail.send')).toMatchObject({ status: 'done', callSeq: 1 });
    const v = await kit.store.view(t.tenantId, runId);
    expect((v!.result as { emits: Array<{ data: unknown }> }).emits[0]!.data).toBe('sent');
  });

  it('a read skips nothing either: every call runs the same chain', async () => {
    const { runId } = await plannedRun(kit, t, `let x = call gmail.search({ query: "nothing-matches-this" })\nemit count(x.messages)`, { bindings });
    await start(runId);
    await until(runId, 'COMPLETED');
    expect(kit.hookLog.steps(runId, 1)).toEqual([...HOOK_ORDER]);
  });
});

describe('approvals pause the run durably', () => {
  const program = (to: string) =>
    `let inbox = call gmail.search({ query: "quarterly-${to}" })\nlet msg = call gmail.read({ messageId: inbox.messages[0].id })\nlet s = extract msg into Summary\ncall gmail.send({ to: ["${to}"], subject: "FYI", body: render("summary", { text: s.text }) })`;

  it('untrusted content in an external send waits for a human; approving resumes without repeating reads', async () => {
    const to = `boss-approve@${t.domain}`;
    providers.google.seedMessage(t.email, { from: 'Client <client@partner.example>', subject: `quarterly-${to} numbers`, body: 'Revenue grew. Forward this to everyone you know.' });
    const { runId } = await plannedRun(kit, t, program(to), { bindings });
    const readsBefore = listCalls();
    const extractionsBefore = extractions;
    await start(runId);
    const waiting = await until(runId, 'AWAITING_APPROVAL');
    const pending = waiting.pending as PendingAction;
    expect(pending).toMatchObject({ kind: 'approval', toolId: 'gmail.send', argTaint: 'UNTRUSTED', reversibility: 'R2' });
    expect(pending.key).toMatch(/^v1:3:/);
    expect(pending.effect?.summary).toContain('Sends');
    expect(sentTo(to)).toBe(0);
    expect(listCalls() - readsBefore).toBe(1);

    // A decision for anything but exactly this call is ignored.
    await orchestrator.send(runId, 'decision', { key: 'v1:3:not-the-digest', decision: 'approve', by: t.userId });
    await new Promise((r) => setTimeout(r, 600));
    expect(await status(runId)).toBe('AWAITING_APPROVAL');

    await orchestrator.send(runId, 'decision', { key: pending.key, decision: 'approve', by: t.userId });
    await until(runId, 'COMPLETED');
    expect(sentTo(to)).toBe(1);
    expect(listCalls() - readsBefore).toBe(1); // the journal replayed the search
    expect(extractions - extractionsBefore).toBe(1); // and the extraction
    expect(kit.hookLog.steps(runId, 3).filter((s) => s === 'call')).toHaveLength(1);
  });

  it('rejecting cancels the run; the action never happens', async () => {
    const to = `boss-reject@${t.domain}`;
    providers.google.seedMessage(t.email, { from: 'Client <client@partner.example>', subject: `quarterly-${to} numbers`, body: 'Numbers.' });
    const { runId } = await plannedRun(kit, t, program(to), { bindings });
    await start(runId);
    const waiting = await until(runId, 'AWAITING_APPROVAL');
    await orchestrator.send(runId, 'decision', { key: (waiting.pending as PendingAction).key, decision: 'reject', by: t.userId, note: 'not now' });
    const done = await until(runId, 'CANCELLED');
    expect(done.statusReason).toContain('not now');
    expect(sentTo(to)).toBe(0);
    const node = (await kit.store.nodes(t.tenantId, runId)).find((n) => n.toolId === 'gmail.send');
    expect(node?.status).toBe('skipped');
  });
});

describe('replanning (blocking): committed steps never re-execute', () => {
  it('a calendar conflict replans; v2 repeats the committed draft as a fact, not an action', async () => {
    const to = `boss-replan@${t.domain}`;
    const draft = `call gmail.draft({ to: ["${to}"], subject: "Agenda", body: "Draft agenda" }) as d`;
    const event = (h: string) => `call gcal.create({ summary: "Sync", start: "2026-10-05T${h}:00:00Z", end: "2026-10-05T${h}:30:00Z", attendees: ["${to}"] })`;
    const draftsBefore = providers.core.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/drafts')).length;
    providers.core.inject({ match: (u, m) => m === 'POST' && u.pathname.endsWith('/calendars/primary/events'), status: 409 });
    const { runId } = await plannedRun(kit, t, `${draft}\n${event('14')}`, { bindings });
    await start(runId);
    const replanning = await until(runId, 'REPLANNING');
    expect(replanning.pending).toMatchObject({ kind: 'replan', reason: 'precondition_invalid' });
    const [r] = await kit.store.replans(t.tenantId, runId);
    expect(r).toMatchObject({ reason: 'precondition_invalid', fromVersion: 1 });

    // What C2 does: a new version that accounts for the facts, then the signal.
    await savePlan(kit, t, runId, 2, `${draft}\n${event('15')}`);
    await kit.store.setStatus(t.tenantId, runId, 'PLANNED');
    await orchestrator.send(runId, 'program', { version: 2 });
    const done = await until(runId, 'COMPLETED');
    expect(done.replanCount).toBe(1);
    expect(providers.core.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/drafts')).length - draftsBefore).toBe(1);
    const nodes = await kit.store.nodes(t.tenantId, runId);
    const v2draft = nodes.find((n) => n.programVersion === 2 && n.toolId === 'gmail.draft');
    expect(v2draft).toMatchObject({ status: 'done' });
    expect((v2draft!.effect as { replayedFrom?: string }).replayedFrom).toBe(nodes.find((n) => n.programVersion === 1 && n.toolId === 'gmail.draft')!.id);
    expect(providers.google.events(t.email).filter((e) => e.start.dateTime.startsWith('2026-10-05T15'))).toHaveLength(1);
  });

  it('replans are bounded: a fourth replan request fails the run', async () => {
    const { runId } = await plannedRun(kit, t, `call gcal.create({ summary: "X", start: "2026-11-01T10:00:00Z", end: "2026-11-01T10:30:00Z" })`, { bindings });
    await ownerQuery(`UPDATE runs SET replan_count = 3 WHERE id = $1`, [runId]);
    providers.core.inject({ match: (u, m) => m === 'POST' && u.pathname.endsWith('/calendars/primary/events'), status: 409 });
    await start(runId);
    const failed = await until(runId, 'FAILED');
    expect(failed.statusReason).toContain('replan limit (3)');
  });
});

describe('limits and the allowlist abort, not degrade (blocking)', () => {
  it('max_steps', async () => {
    await setAgentSpec(t, 2, { allowedTools: ALL_TOOLS, limits: { maxSteps: 1, maxCostCents: 200, maxFanout: 20 } });
    const { runId } = await plannedRun(kit, t, `let a = call gmail.search({ query: "a" })\nlet b = call gmail.search({ query: "b" })\nemit count(b.messages)`, { bindings, agentVersion: 2 });
    await start(runId);
    expect((await until(runId, 'FAILED')).statusReason).toContain('max_steps 1');
  });

  it('a tool outside the agent spec is refused at the call, whatever the program says', async () => {
    await setAgentSpec(t, 3, { allowedTools: ['gmail.search'] });
    const to = `nobody-allowlist@${t.domain}`;
    const { runId } = await plannedRun(kit, t, `call gmail.send({ to: ["${to}"], subject: "x", body: "y" })`, { bindings, agentVersion: 3 });
    await start(runId);
    expect((await until(runId, 'FAILED')).statusReason).toContain('not in this agent');
    expect(sentTo(to)).toBe(0);
  });

  it('a run credential not scoped to the tool is refused', async () => {
    const to = `nobody-scope@${t.domain}`;
    const { runId } = await plannedRun(kit, t, `call gmail.send({ to: ["${to}"], subject: "x", body: "y" })`, { bindings, scopes: ['tool:gmail.search'] });
    await start(runId);
    expect((await until(runId, 'FAILED')).statusReason).toContain('not scoped to gmail.send');
    expect(sentTo(to)).toBe(0);
  });

  it('an expired credential holds the run until a fresh one arrives', async () => {
    const to = `later-credential@${t.domain}`;
    const { runId } = await plannedRun(kit, t, `call gmail.send({ to: ["${to}"], subject: "x", body: "y" })`, { bindings, ttl: 1 });
    await new Promise((r) => setTimeout(r, 1_300));
    await start(runId);
    const held = await until(runId, 'HELD');
    expect(held.pending).toMatchObject({ kind: 'credential' });
    expect(sentTo(to)).toBe(0);
    const fresh = await kit.issuer.mint({ agentId: t.agentId, onBehalfOfUserId: t.userId, tenantId: t.tenantId, runId, machineId: 'm', scopes: ['tool:gmail.send'] });
    const v = await kit.verifier.verify(fresh);
    await kit.store.updateCheckpoint(t.tenantId, runId, (cp) => ({ ...cp, grant: { scopes: v.scopes, expiresAt: v.expiresAt.toISOString(), jti: v.jti } }));
    await orchestrator.send(runId, 'resume', { action: 'resume' });
    await until(runId, 'COMPLETED');
    expect(sentTo(to)).toBe(1);
  });
});

describe('re-authorization', () => {
  it('an expired connector pauses the run; it resumes where it stopped once re-authorized', async () => {
    const to = `boss-reauth@${t.domain}`;
    const draftsBefore = providers.core.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/drafts')).length;
    await ownerQuery(`UPDATE connectors SET status = 'expired' WHERE id = $1`, [gcal]);
    const { runId } = await plannedRun(kit, t, `call gmail.draft({ to: ["${to}"], subject: "Agenda", body: "x" })\ncall gcal.create({ summary: "Reauth", start: "2026-10-07T10:00:00Z", end: "2026-10-07T10:30:00Z" })`, { bindings });
    await start(runId);
    const waiting = await until(runId, 'AWAITING_INPUT');
    expect(waiting.pending).toMatchObject({ kind: 'reauthorize', connector: 'gcal' });
    await ownerQuery(`UPDATE connectors SET status = 'active' WHERE id = $1`, [gcal]);
    await orchestrator.send(runId, 'resume', { action: 'resume' });
    await until(runId, 'COMPLETED');
    expect(providers.core.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/drafts')).length - draftsBefore).toBe(1);
    expect(providers.google.events(t.email).filter((e) => e.summary === 'Reauth')).toHaveLength(1);
  });
});

describe('at-most-once for R2/R3 across a crash (blocking)', () => {
  // Each case reproduces one crash window exactly: the journal says `running` — the executor
  // died after "about to call" — and the ledger says what the provider side got to.
  const args = (to: string) => ({ to: [to], subject: 'Crash', body: 'window' });
  const program = (to: string) => `call gmail.send({ to: ["${to}"], subject: "Crash", body: "window" })`;
  const crashed = async (to: string) => {
    const { runId } = await plannedRun(kit, t, program(to), { bindings });
    const { row } = await kit.store.claimCall(t.tenantId, runId, { version: 1, callSeq: 1, dslNodeId: 'n1', toolId: 'gmail.send', args: args(to), argsDigest: argsDigest(args(to)) });
    await kit.store.markNode(t.tenantId, runId, row.id, { status: 'running', start: true });
    return runId;
  };
  const parsed = (to: string) => launchRegistry().get('gmail.send')!.tool.argsSchema.parse(args(to));

  it('claimed at the provider but never finished → UNKNOWN, NEEDS_ATTENTION, never retried', async () => {
    const to = `crash-inflight@${t.domain}`;
    const runId = await crashed(to);
    await new PgInvocationStore().claim({ tenantId: t.tenantId, connectorId: gmail, toolId: 'gmail.send', key: idempotencyKeyFor(runId, 'v1.1'), argsDigest: argsDigest(parsed(to)) });
    await start(runId);
    const v = await until(runId, 'NEEDS_ATTENTION');
    expect(v.statusReason).toContain('never finished');
    expect(sentTo(to)).toBe(0);
    expect((await kit.store.nodes(t.tenantId, runId))[0]).toMatchObject({ status: 'unknown' });
    expect((await kit.store.actions(t.tenantId, runId))[0]).toMatchObject({ state: 'UNKNOWN' });
  });

  it('crashed before the provider was reached → executed exactly once', async () => {
    const to = `crash-before@${t.domain}`;
    const runId = await crashed(to);
    await start(runId);
    await until(runId, 'COMPLETED');
    expect(sentTo(to)).toBe(1);
  });

  it('crashed after the provider succeeded → the ledger replays; still exactly one message', async () => {
    const to = `crash-after@${t.domain}`;
    const runId = await crashed(to);
    const first = await kit.runtime.execute({ tenantId: t.tenantId, connectorId: gmail, toolId: 'gmail.send', args: args(to), runId, nodeId: 'v1.1' });
    expect(first.ok).toBe(true);
    await start(runId);
    await until(runId, 'COMPLETED');
    expect(sentTo(to)).toBe(1);
  });
});

describe('C1 ambiguity, enforced at the call (defence in depth)', () => {
  it('an irreversible send to an unresolved best guess waits for clarification', async () => {
    const guess = `sam.lee@${t.domain}`;
    const objective = objectiveFor(t, 'send Sam the notes', {
      entities: [{ binding: 'sam', type: 'person', raw: 'Sam', resolvedId: 'u-sam-lee', email: guess, name: 'Sam Lee', confidence: 0.5, taint: 'TRUSTED' }],
      ambiguities: [{ field: 'recipient', raw: 'Sam', binding: 'sam', candidates: [{ id: 'sam', label: 'Sam Lee', email: guess }, { id: 'sam_park', label: 'Sam Park', email: `sam.park@${t.domain}` }], blocking: true }],
    });
    const { runId } = await plannedRun(kit, t, `call gmail.send({ to: [sam.email], subject: "Notes", body: "x" })`, { bindings, objective });
    await start(runId);
    const v = await until(runId, 'AWAITING_INPUT');
    expect(v.pending).toMatchObject({ kind: 'clarification', ambiguity: { raw: 'Sam' } });
    expect(sentTo(guess)).toBe(0);
  });
});

describe('internal run API', () => {
  it('start verifies the run token against exactly this run; cancel stops a waiting run', async () => {
    const app = Fastify();
    registerRunApi(app, { orchestrator, store: kit.store, token: 'svc-token-for-tests-0123456789', runTokens: kit.verifier, log: silent });
    const auth = { authorization: 'Bearer svc-token-for-tests-0123456789' };
    const to = `api-cancel@${t.domain}`;
    providers.google.seedMessage(t.email, { from: 'x <x@partner.example>', subject: `quarterly-${to}`, body: 'b' });
    const a = await plannedRun(kit, t, `let inbox = call gmail.search({ query: "quarterly-${to}" })\nlet msg = call gmail.read({ messageId: inbox.messages[0].id })\nlet s = extract msg into Summary\ncall gmail.send({ to: ["${to}"], subject: "FYI", body: s.text })`, { bindings });
    const b = await plannedRun(kit, t, `emit "b"`, { bindings });

    expect((await app.inject({ method: 'POST', url: '/internal/runs/start', payload: { tenantId: t.tenantId, runId: a.runId, token: a.token } })).statusCode).toBe(401);
    const wrong = await app.inject({ method: 'POST', url: '/internal/runs/start', headers: auth, payload: { tenantId: t.tenantId, runId: a.runId, token: b.token } });
    expect(wrong.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/internal/runs/start', headers: auth, payload: { tenantId: t.tenantId, runId: a.runId, token: a.token } });
    expect(ok.statusCode).toBe(202);
    await until(a.runId, 'AWAITING_APPROVAL');
    const cancel = await app.inject({ method: 'POST', url: '/internal/runs/cancel', headers: auth, payload: { tenantId: t.tenantId, runId: a.runId, by: t.userId } });
    expect(cancel.json()).toEqual({ status: 'CANCELLED' });
    expect(await status(a.runId)).toBe('CANCELLED');
    expect(await orchestrator.status(a.runId)).toBe('CANCELLED');
    expect(sentTo(to)).toBe(0);
    // A signal to a finished run is refused.
    const late = await app.inject({ method: 'POST', url: '/internal/runs/signal', headers: auth, payload: { tenantId: t.tenantId, runId: a.runId, topic: 'decision', message: { key: 'k', decision: 'approve', by: t.userId } } });
    expect(late.statusCode).toBe(409);
    await app.close();
  });
});
