import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SYSTEM_TENANT } from '@vega/idp';
import { PRINCIPAL_HEADER } from '../src/app.js';
import { fastRevokeKeys, mintRevokeToken, ReversibilityStore, type FastRevokeEntry } from '@vega/compensators';
import { RunStore } from '@vega/runs';
import type { AgentCoreDeps } from '../src/agent/coordinator.js';
import { createHarness, problemOf, type Harness } from './harness.js';

/**
 * THE REVERSIBILITY API (docs/module6.md §5.5, §7, §10) against real Postgres and OpenFGA: the
 * revoke / release / edit decisions committed on the hold row, the asymmetry between them, the
 * one-tap capability, undo with a confirmation for third-party-visible consequences, Time-to-Undo,
 * incidents.
 */

vi.setConfig({ testTimeout: 30_000 });
process.env['LOCAL_KEK_BASE64'] ??= randomBytes(32).toString('base64');

const OWNER_URL = process.env['DATABASE_URL'] ?? 'postgresql://vega:vega_local_dev_only@localhost:5432/vega';
const owner = new pg.Pool({ connectionString: OWNER_URL, max: 2 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await owner.query<T>(sql, params)).rows;
const rstore = new ReversibilityStore();
const signals: Array<{ runId: string; message: Record<string, unknown> }> = [];
const rollbacks: Array<Record<string, unknown>> = [];
const cache = new Map<string, string>();
let h: Harness;
let A: Awaited<ReturnType<Harness['tenant']>>;
let member = '';
let approver = '';
let runId = '';
let step = 0;

async function node(tool = 'gmail.send') {
  return (await q<{ id: string }>(`INSERT INTO task_nodes (tenant_id, run_id, program_version, step_index, call_seq, kind, tool_id, status) VALUES ($1, $2, 1, $3, $3, 'TOOL_CALL', $4, 'held') RETURNING id`, [A.tenantId, runId, ++step, tool]))[0]!.id;
}
async function action(nodeId: string, tool: string, rev: string, state = 'HELD') {
  return (await q<{ id: string }>(`INSERT INTO actions (tenant_id, run_id, node_id, tool_id, args_digest, taint_level, reversibility, state) VALUES ($1, $2, $3, $4, 'x', 'TRUSTED', $5, $6) RETURNING id`, [A.tenantId, runId, nodeId, tool, rev, state]))[0]!.id;
}
/** A hold as the executor opens it: row, precomputed revokers, fast-path cache, capability. */
async function hold(opts: { allowed?: string[]; body?: string } = {}) {
  const n = await node();
  const a = await action(n, 'gmail.send', 'R2');
  const cap = mintRevokeToken(A.tenantId);
  const allowed = opts.allowed ?? [A.userId, approver];
  const row = await rstore.createHold(A.tenantId, {
    runId, nodeId: n, actionId: a, holdKey: `k${step}`, toolId: 'gmail.send', windowMs: 600_000, expiresAt: new Date(Date.now() + 600_000), allowedRevokers: allowed, revokeTokenHash: cap.hash,
    artifact: { toolId: 'gmail.send', args: { to: ['peter@partner.example'], subject: 'Terms', body: opts.body ?? 'Draft terms' }, effect: { summary: 'Sends "Terms" to 1 recipient', externalRecipients: ['peter@partner.example'], recordsAffected: [], fidelity: 'DERIVED' }, reason: 'external send' },
  });
  const entry: FastRevokeEntry = { tenantId: A.tenantId, runId, holdId: row.id, toolId: 'gmail.send', allowed, expiresAt: row.expiresAt.toISOString() };
  cache.set(fastRevokeKeys.hold(row.id), JSON.stringify(entry));
  cache.set(fastRevokeKeys.token(cap.hash), row.id);
  return { id: row.id, actionId: a, token: cap.token };
}
async function compensation(opts: { side: 'SILENT' | 'NOTIFIES_THIRD_PARTY'; ttlMs?: number; committedAgo?: number }) {
  const n = await node('gcal.create');
  const a = await action(n, 'gcal.create', 'R1', 'COMMITTED');
  await rstore.arm(A.tenantId, { runId, nodeId: n, connectorId: A.userId, token: { ref: 'gcal.event.delete', toolId: 'gcal.create', args: { summary: 'Kickoff' }, pre: {}, forward: null, capturedAt: new Date().toISOString() }, compensator: { ref: 'gcal.event.delete', toolId: 'gcal.create', confidence: 'APPROXIMATE', sideEffects: opts.side, ttlMs: opts.ttlMs ?? 90 * 86_400_000 }, description: 'Deletes “Kickoff” and sends a cancellation to 3 attendees. They will see that it was cancelled.' });
  await rstore.bindForward(A.tenantId, n, { outcome: 'committed', forward: { providerRef: 'e1', detail: {}, recordsAffected: [] }, actionId: a, at: new Date(Date.now() - (opts.committedAgo ?? 0)) });
  return a;
}

beforeAll(async () => {
  h = await createHarness({ reversibility: { store: rstore, cache: { get: async (k) => cache.get(k) ?? null }, pushSecret: 'push-secret' } });
  const execution = {
    signalRun: async (i: { runId: string; message: Record<string, unknown> }) => void signals.push({ runId: i.runId, message: i.message }),
    toolDeclarations: async () => [{ toolId: 'gmail.send', recipientArgs: ['to', 'cc', 'bcc'] }],
    startRollback: async (i: Record<string, unknown>) => (rollbacks.push(i), { rollbackId: '00000000-0000-4000-8000-000000000001', compensations: [String(i['compensationId'] ?? 'all')] }),
  };
  h.deps.agent = { core: { store: new RunStore(), execution, log: h.deps.logger } as unknown as AgentCoreDeps, coordinator: {} as never };
  A = await h.tenant('teams');
  const mk = async (role: string, name: string) => (await q<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, role, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`, [A.tenantId, `${name}-${A.tenantId.slice(0, 6)}@example.com`, name, role]))[0]!.id;
  member = await mk('MEMBER', 'member');
  approver = await mk('APPROVER', 'approver');
  const [ag] = await q<{ id: string }>(`INSERT INTO agents (tenant_id, workspace_id, name, owner_user_id, idp_machine_id, status) VALUES ($1, $2, 'a', $3, 'm', 'active') RETURNING id`, [A.tenantId, A.workspaceId, A.userId]);
  runId = (await q<{ id: string }>(`INSERT INTO runs (tenant_id, workspace_id, agent_id, principal_user_id, trigger, objective_json, status) VALUES ($1, $2, $3, $4, 'chat', '{"objective":"x","entities":[],"constraints":[],"successCriteria":[],"ambiguities":[],"requestedAutonomy":"supervised","origin":{"kind":"principal","principalUserId":"${A.userId}"}}', 'HELD') RETURNING id`, [A.tenantId, A.workspaceId, ag!.id, A.userId]))[0]!.id;
}, 60_000);
afterAll(async () => {
  await h?.close();
  await owner.end();
});

const me = () => h.as(A.tenantId, A.userId);
const as = (u: string) => h.as(A.tenantId, u);

describe('revoke: one tap, no confirmation, precomputed authorization', () => {
  it('commits on the hold row, records Time-to-Undo, and wakes the run', async () => {
    const { id, actionId } = await hold();
    const out = await me().holds.revoke.mutate({ id });
    expect(out).toMatchObject({ revoked: true, state: 'revoked' });
    const [row] = await q<{ state: string; revoke_channel: string; revoked_by: string }>(`SELECT * FROM holds WHERE id = $1`, [id]);
    expect(row).toMatchObject({ state: 'revoked', revoke_channel: 'app', revoked_by: A.userId });
    expect((await q<{ state: string }>(`SELECT state FROM actions WHERE id = $1`, [actionId]))[0]!.state).toBe('REVOKED');
    expect(await q(`SELECT 1 FROM undo_metrics WHERE action_id = $1 AND kind = 'revoke' AND succeeded`, [actionId])).toHaveLength(1);
    expect(signals.at(-1)).toMatchObject({ runId, message: { action: 'revoke', holdId: id } });
  });

  it('whoever the hold names may revoke (an approver), nobody else (a member)', async () => {
    const a = await hold();
    expect((await problemOf(as(member).holds.revoke.mutate({ id: a.id }))).status).toBe(403);
    expect(await as(approver).holds.revoke.mutate({ id: a.id })).toMatchObject({ revoked: true });
  });

  it('uses the precomputed list — no relationship check, no database read', async () => {
    const a = await hold({ allowed: [A.userId] });
    // The cache (what the executor precomputed) names the member; the row does not.
    cache.set(fastRevokeKeys.hold(a.id), JSON.stringify({ tenantId: A.tenantId, runId, holdId: a.id, toolId: 'gmail.send', allowed: [member], expiresAt: new Date().toISOString() }));
    expect(await as(member).holds.revoke.mutate({ id: a.id })).toMatchObject({ revoked: true });
  });

  it('too late is said plainly, never an error that hides what happened', async () => {
    const a = await hold();
    await rstore.decideHold(A.tenantId, a.id, 'expired_released');
    expect(await me().holds.revoke.mutate({ id: a.id })).toMatchObject({ revoked: false, message: expect.stringContaining('already ended and it was released') });
  });
});

describe('the one-tap capability from a push (no session)', () => {
  const tap = (token: string) => h.raw({}).holds.revokeWithToken.mutate({ token });
  it('revokes exactly its hold, attributed to the person it was sent to', async () => {
    const hdr = { [PRINCIPAL_HEADER]: await h.issuer.mint({ tenantId: SYSTEM_TENANT, userId: 'system:hold_revoke', system: 'hold_revoke' }) };
    const client = h.raw(hdr);
    const a = await hold();
    const b = await hold();
    expect(await client.holds.revokeWithToken.mutate({ token: a.token })).toMatchObject({ revoked: true });
    const [row] = await q<{ state: string; revoke_channel: string; revoked_by: string }>(`SELECT * FROM holds WHERE id = $1`, [a.id]);
    expect(row).toMatchObject({ state: 'revoked', revoke_channel: 'push', revoked_by: A.userId });
    expect((await q<{ state: string }>(`SELECT state FROM holds WHERE id = $1`, [b.id]))[0]!.state).toBe('holding');
    // A forged capability for the same tenant finds nothing.
    expect((await problemOf(client.holds.revokeWithToken.mutate({ token: mintRevokeToken(A.tenantId).token }))).status).toBe(404);
    // The capability principal can do nothing else: not even read a hold.
    expect((await problemOf(client.holds.get.query({ id: b.id }))).status).toBe(403);
    // Without the system assertion there is no way in at all.
    expect((await problemOf(tap(b.token))).status).toBe(403);
  });
});

describe('release and edit need a signed-in person who may act on the run', () => {
  it('a member cannot release; the principal can', async () => {
    const a = await hold();
    expect((await problemOf(as(member).holds.release.mutate({ id: a.id }))).status).toBe(403);
    expect(await me().holds.release.mutate({ id: a.id })).toEqual({ released: true });
    expect(signals.at(-1)!.message).toMatchObject({ action: 'release' });
  });

  it('shows the held content only to those who may revoke it', async () => {
    const a = await hold({ body: 'Confidential terms' });
    expect(await me().holds.get.query({ id: a.id })).toMatchObject({ artifact: { args: { body: 'Confidential terms' } }, editable: ['subject', 'body'] });
    expect((await problemOf(as(member).holds.get.query({ id: a.id }))).status).toBe(403);
  });

  it('edit changes content only — never recipients — and records the diff', async () => {
    const a = await hold();
    const bad = await problemOf(me().holds.edit.mutate({ id: a.id, patch: { to: ['evil@x.example'] } }));
    expect(bad.status).toBe(400);
    expect(await me().holds.edit.mutate({ id: a.id, patch: { body: 'Final terms' } })).toEqual({ edited: true, fields: ['body'] });
    const [row] = await q<{ state: string; edit_diff: unknown }>(`SELECT * FROM holds WHERE id = $1`, [a.id]);
    expect(row).toMatchObject({ state: 'edited_requeued', edit_diff: { fields: { body: { before: 'Draft terms', after: 'Final terms' } } } });
    expect(signals.at(-1)!.message).toMatchObject({ action: 'edit' });
  });
});

describe('undo (§6.3): honest, confirmed when others will see it', () => {
  it('describes the consequence and how long it stays possible', async () => {
    const a = await compensation({ side: 'NOTIFIES_THIRD_PARTY' });
    const out = await me().undo.compensation.query({ actionId: a });
    expect(out.compensation).toMatchObject({ confidence: 'APPROXIMATE', sideEffects: 'NOTIFIES_THIRD_PARTY', undoable: true, availableFor: '89 days' });
  });

  it('a third-party-visible undo needs confirm: true (428 carries the consequence)', async () => {
    const a = await compensation({ side: 'NOTIFIES_THIRD_PARTY' });
    const p = await problemOf(me().undo.compensate.mutate({ actionId: a }));
    expect(p).toMatchObject({ status: 428, detail: expect.stringContaining('They will see that it was cancelled') });
    expect(await me().undo.compensate.mutate({ actionId: a, confirm: true })).toMatchObject({ rollbackId: expect.any(String) });
    expect(rollbacks.at(-1)).toMatchObject({ scope: 'action', requestedBy: A.userId });
  });

  it('a silent undo runs without confirmation; an expired one is refused as permanent', async () => {
    const silent = await compensation({ side: 'SILENT' });
    await me().undo.compensate.mutate({ actionId: silent });
    const old = await compensation({ side: 'SILENT', ttlMs: 60_000, committedAgo: 120_000 });
    expect(await problemOf(me().undo.compensate.mutate({ actionId: old }))).toMatchObject({ status: 422, detail: expect.stringContaining('permanent') });
  });

  it('an email cannot be undone once sent, and says so', async () => {
    const n = await node();
    const a = await action(n, 'gmail.send', 'R2', 'COMMITTED');
    expect(await me().undo.compensation.query({ actionId: a })).toMatchObject({ compensation: null, explanation: expect.stringContaining('only be stopped while it was held') });
  });

  it('a member of nothing cannot undo someone else’s run', async () => {
    const a = await compensation({ side: 'SILENT' });
    expect((await problemOf(as(member).undo.compensate.mutate({ actionId: a }))).status).toBe(403);
  });
});

describe('metrics and incidents', () => {
  it('Time-to-Undo per action type', async () => {
    const out = await me().reversibility.timeToUndo.query({ days: 1 });
    expect(out.items.find((i) => i.toolId === 'gmail.send' && i.kind === 'revoke')).toMatchObject({ successRate: 1, medianMs: expect.any(Number) });
  });

  it('incidents are listed, acknowledged and resolved by the right roles', async () => {
    const inc = await rstore.openIncident(A.tenantId, { kind: 'compensation_failed', severity: 'HIGH', title: 'Could not undo gcal.create', runId, detail: { steps: ['Open Google Calendar'] } });
    expect((await me().reversibility.incidents.query({ state: 'open' })).items.some((i) => i.id === inc.id)).toBe(true);
    expect((await problemOf(as(member).reversibility.incidents.query({})))).toMatchObject({ status: 403 });
    await me().reversibility.acknowledgeIncident.mutate({ id: inc.id });
    expect(await me().reversibility.resolveIncident.mutate({ id: inc.id, resolution: 'Deleted the event by hand' })).toMatchObject({ state: 'resolved' });
  });

  it('each person has their own push topic', async () => {
    const a = await me().reversibility.pushTopic.query();
    const b = await as(member).reversibility.pushTopic.query();
    expect(a.topic).toMatch(/^hold-/);
    expect(a.topic).not.toBe(b.topic);
  });
});

