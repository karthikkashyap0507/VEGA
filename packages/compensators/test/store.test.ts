import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CompensationToken } from '@vega/connector-sdk';
import { ReversibilityStore } from '../src/index.js';

/** The store against Postgres as the application role: sealing at rest, the compare-and-set arbiters. */
process.env['DATABASE_URL'] ??= 'postgresql://vega:vega_local_dev_only@localhost:5432/vega';
process.env['DATABASE_APP_URL'] ??= 'postgresql://vega_app:vega_app_local_dev_only@localhost:5432/vega';
process.env['LOCAL_KEK_BASE64'] ??= randomBytes(32).toString('base64');

const owner = new pg.Pool({ connectionString: process.env['DATABASE_URL'], max: 2 });
const store = new ReversibilityStore();
let tenantId = '';
let userId = '';
let runId = '';

let step = 0;
async function node(): Promise<string> {
  const r = await owner.query<{ id: string }>(`INSERT INTO task_nodes (tenant_id, run_id, program_version, step_index, call_seq, kind, tool_id, status) VALUES ($1, $2, 1, $3, $3, 'TOOL_CALL', 'gcal.create', 'running') RETURNING id`, [tenantId, runId, ++step]);
  return r.rows[0]!.id;
}
const token = (summary: string): CompensationToken => ({ ref: 'gcal.event.delete', toolId: 'gcal.create', args: { summary, attendees: [] }, pre: { eventId: 'e1' }, forward: null, capturedAt: new Date().toISOString() });
const info = { ref: 'gcal.event.delete', toolId: 'gcal.create', confidence: 'APPROXIMATE' as const, sideEffects: 'NOTIFIES_THIRD_PARTY' as const, ttlMs: 60_000 };

beforeAll(async () => {
  const slug = `rev-${randomBytes(4).toString('hex')}`;
  tenantId = (await owner.query<{ id: string }>(`INSERT INTO tenants (name, slug, plan, retention_days) VALUES ($1, $2, 'teams', 400) RETURNING id`, [slug, slug])).rows[0]!.id;
  userId = (await owner.query<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, role, status) VALUES ($1, $2, 'O', 'OWNER', 'active') RETURNING id`, [tenantId, `o@${slug}.example`])).rows[0]!.id;
  const ws = (await owner.query<{ id: string }>(`INSERT INTO workspaces (tenant_id, name, slug) VALUES ($1, 'W', 'w') RETURNING id`, [tenantId])).rows[0]!.id;
  const ag = (await owner.query<{ id: string }>(`INSERT INTO agents (tenant_id, workspace_id, name, owner_user_id, idp_machine_id, status) VALUES ($1, $2, 'a', $3, 'm', 'active') RETURNING id`, [tenantId, ws, userId])).rows[0]!.id;
  runId = (await owner.query<{ id: string }>(`INSERT INTO runs (tenant_id, workspace_id, agent_id, principal_user_id, trigger, objective_json, status) VALUES ($1, $2, $3, $4, 'api', '{"objective":"x"}', 'EXECUTING') RETURNING id`, [tenantId, ws, ag, userId])).rows[0]!.id;
});
afterAll(() => owner.end());

describe('compensations', () => {
  it('seals the token at rest and binds the forward outcome once, in commit order', async () => {
    const n1 = await node();
    const n2 = await node();
    const c1 = await store.arm(tenantId, { runId, nodeId: n1, connectorId: userId, token: token('Board meeting — secret agenda'), compensator: info, description: 'd' });
    const c2 = await store.arm(tenantId, { runId, nodeId: n2, connectorId: userId, token: token('second'), compensator: info, description: 'd' });
    const raw = await owner.query<{ t: unknown }>(`SELECT token_sealed AS t FROM compensations WHERE id = $1`, [c1]);
    expect(JSON.stringify(raw.rows[0]!.t)).not.toContain('secret agenda');

    const b1 = await store.bindForward(tenantId, n1, { outcome: 'committed', forward: { providerRef: 'e1', detail: { eventId: 'e1' }, recordsAffected: [] } });
    const b2 = await store.bindForward(tenantId, n2, { outcome: 'unknown', forward: null });
    expect(b1!.ttlAt!.getTime() - b1!.committedAt!.getTime()).toBe(60_000);
    expect(b2!.commitSeq!).toBeGreaterThan(b1!.commitSeq!);
    expect((await store.openToken(tenantId, c1)).forward?.providerRef).toBe('e1');
    // Re-arming or re-binding a call whose forward outcome is known changes nothing.
    await store.arm(tenantId, { runId, nodeId: n1, connectorId: userId, token: token('replaced?'), compensator: info, description: 'changed' });
    expect((await store.openToken(tenantId, c1)).args).toMatchObject({ summary: 'Board meeting — secret agenda' });
    expect((await store.bindForward(tenantId, n1, { outcome: 'failed', forward: null }))!.forwardState).toBe('committed');
    expect((await store.forRun(tenantId, runId)).map((c) => c.id).slice(0, 2)).toEqual([c2, c1]);
  });

  it('a failed forward call makes its compensation not_needed', async () => {
    const n = await node();
    await store.arm(tenantId, { runId, nodeId: n, connectorId: userId, token: token('x'), compensator: info, description: 'd' });
    expect((await store.bindForward(tenantId, n, { outcome: 'failed', forward: null }))!.state).toBe('not_needed');
  });

  it('exactly one of many concurrent claims runs a compensation', async () => {
    const n = await node();
    const id = await store.arm(tenantId, { runId, nodeId: n, connectorId: userId, token: token('x'), compensator: info, description: 'd' });
    await store.bindForward(tenantId, n, { outcome: 'committed', forward: null });
    const rb = await store.createRollback(tenantId, { runId, scope: 'action', trigger: 'user', requestedBy: userId, requestedAt: new Date(), compensationIds: [id] });
    const claims = await Promise.all(Array.from({ length: 8 }, () => store.claim(tenantId, id, rb.id)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    await store.finish(tenantId, id, { state: 'succeeded', result: { outcome: 'restored', summary: 's', notified: [] } });
    expect((await store.get(tenantId, id))!.state).toBe('succeeded');
    expect(await store.claim(tenantId, id, rb.id)).toBeNull();
  });
});

describe('holds: the arbiter between a revoke and the timer', () => {
  it('whichever commits first wins; the other sees it', async () => {
    for (let i = 0; i < 10; i++) {
      const n = await node();
      const h = await store.createHold(tenantId, { runId, nodeId: n, actionId: null, holdKey: `k${i}-${n}`, toolId: 'gmail.send', windowMs: 1000, expiresAt: new Date(), allowedRevokers: [userId], revokeTokenHash: null, artifact: { toolId: 'gmail.send', args: { body: 'confidential' }, effect: null, reason: 'r' } });
      const [a, b] = await Promise.all([store.decideHold(tenantId, h.id, 'revoked', { by: userId, channel: 'push' }), store.decideHold(tenantId, h.id, 'expired_released')]);
      expect(Number(a.won) + Number(b.won)).toBe(1);
      expect(a.hold!.state).toBe(b.hold!.state);
    }
  });

  it('creating the same hold twice (a replayed step) returns the first', async () => {
    const n = await node();
    const input = { runId, nodeId: n, actionId: null, holdKey: `dup-${n}`, toolId: 'gmail.send', windowMs: 1000, expiresAt: new Date(), allowedRevokers: [userId], revokeTokenHash: null, artifact: { toolId: 'gmail.send', args: {}, effect: null, reason: 'r' } };
    const a = await store.createHold(tenantId, input);
    const b = await store.createHold(tenantId, input);
    expect(b.id).toBe(a.id);
    const raw = await owner.query<{ a: unknown }>(`SELECT artifact_sealed AS a FROM holds WHERE id = $1`, [a.id]);
    expect(raw.rows[0]!.a).toMatchObject({ v: 1 });
  });
});
