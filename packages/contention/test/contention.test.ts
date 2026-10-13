import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closePools, migrate } from '@vega/db';
import { ContactLedger, DEFAULT_COOLDOWN_MS, LockManager, normalizeIdentity, union, WriteReconciler } from '../src/index.js';

// These suites seed real history and share one database with the rest of the workspace's suites;
// under a full parallel run the 5s default is a flake, not a signal.
vi.setConfig({ testTimeout: 60_000 });

/**
 * Module 10B against real Postgres: entity locks (modes, leases, deadlock cycles, the 20-agent
 * chaos), the contact ledger (cooldowns, identity normalization, atomic check-and-record), and
 * write reconciliation. §19 "BLOCKING" suites are marked ★.
 */

const OWNER_URL = process.env['DATABASE_URL'] ?? 'postgresql://vega:vega_local_dev_only@localhost:5432/vega';
let pool: pg.Pool;

interface T {
  tenantId: string;
  userId: string;
  workspaceId: string;
  agents: string[];
}

async function tenant(nAgents = 3): Promise<T> {
  const slug = `con-${randomBytes(4).toString('hex')}`;
  const tenantId = (await pool.query<{ id: string }>(`INSERT INTO tenants (name, slug, plan, retention_days) VALUES ($1,$2,'business',400) RETURNING id`, [slug, slug])).rows[0]!.id;
  const userId = (await pool.query<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, role, status) VALUES ($1,$2,'o','OWNER','active') RETURNING id`, [tenantId, `o@${slug}.example`])).rows[0]!.id;
  const workspaceId = (await pool.query<{ id: string }>(`INSERT INTO workspaces (tenant_id, name, slug) VALUES ($1,'W','w') RETURNING id`, [tenantId])).rows[0]!.id;
  const agents: string[] = [];
  for (let i = 0; i < nAgents; i++) agents.push((await pool.query<{ id: string }>(`INSERT INTO agents (tenant_id, workspace_id, name, owner_user_id, idp_machine_id, status) VALUES ($1,$2,$3,$4,'m','active') RETURNING id`, [tenantId, workspaceId, `a${i}`, userId])).rows[0]!.id);
  return { tenantId, userId, workspaceId, agents };
}

/** A real run row (the deadlock tie-break reads `runs.started_at`). */
async function run(t: T, agent = t.agents[0]!, startedAt = new Date()): Promise<string> {
  return (await pool.query<{ id: string }>(`INSERT INTO runs (tenant_id, workspace_id, agent_id, principal_user_id, trigger, objective_json, status, started_at) VALUES ($1,$2,$3,$4,'api','{"objective":"x"}','EXECUTING',$5) RETURNING id`, [t.tenantId, t.workspaceId, agent, t.userId, startedAt])).rows[0]!.id;
}

beforeAll(async () => {
  await migrate(OWNER_URL);
  pool = new pg.Pool({ connectionString: OWNER_URL, max: 8, keepAlive: true, idleTimeoutMillis: 5_000 });
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await closePools();
});

describe('entity locks (§10.1)', () => {
  const locks = new LockManager();
  const base = (t: T, runId: string, agent: string, entityKey: string, mode: 'SHARED_READ' | 'EXCLUSIVE_WRITE' | 'COMMUNICATION', extra: { riskTier?: string; leaseMs?: number } = {}) => ({
    tenantId: t.tenantId,
    entityKey,
    mode,
    runId,
    agentId: agent,
    intent: `${mode.toLowerCase()} ${entityKey}`,
    ...extra,
  });

  it('one writer per entity: the second is refused and told who holds it and why', async () => {
    const t = await tenant();
    const [r1, r2] = [await run(t), await run(t, t.agents[1])];
    const a = await locks.acquire({ ...base(t, r1, t.agents[0]!, 'crm:account:8812', 'EXCLUSIVE_WRITE'), intent: 'sending quarterly review' });
    expect(a).toMatchObject({ ok: true, reentrant: false });
    const b = await locks.acquire(base(t, r2, t.agents[1]!, 'crm:account:8812', 'EXCLUSIVE_WRITE'));
    expect(b).toMatchObject({ ok: false, victim: false, heldBy: { runId: r1, agentId: t.agents[0], intent: 'sending quarterly review' } });
  });

  it('shared readers coexist; a writer waits for them; readers wait for a writer', async () => {
    const t = await tenant();
    const [r1, r2, r3] = [await run(t), await run(t, t.agents[1]), await run(t, t.agents[2])];
    expect((await locks.acquire(base(t, r1, t.agents[0]!, 'client:44', 'SHARED_READ'))).ok).toBe(true);
    expect((await locks.acquire(base(t, r2, t.agents[1]!, 'client:44', 'SHARED_READ'))).ok).toBe(true);
    expect((await locks.acquire(base(t, r3, t.agents[2]!, 'client:44', 'EXCLUSIVE_WRITE'))).ok).toBe(false);
    await locks.releaseAllForRun(t.tenantId, r1);
    await locks.releaseAllForRun(t.tenantId, r2);
    expect((await locks.acquire(base(t, r3, t.agents[2]!, 'client:44', 'EXCLUSIVE_WRITE'))).ok).toBe(true);
    expect((await locks.acquire(base(t, r1, t.agents[0]!, 'client:44', 'SHARED_READ'))).ok).toBe(false);
  });

  it('the same run re-acquiring is reentrant, not a conflict with itself', async () => {
    const t = await tenant();
    const r = await run(t);
    await locks.acquire(base(t, r, t.agents[0]!, 'crm:account:1', 'EXCLUSIVE_WRITE'));
    expect(await locks.acquire(base(t, r, t.agents[0]!, 'crm:account:1', 'EXCLUSIVE_WRITE'))).toMatchObject({ ok: true, reentrant: true });
  });

  it('COMMUNICATION: only one agent contacts a given human at a time', async () => {
    const t = await tenant();
    const [r1, r2] = [await run(t), await run(t, t.agents[1])];
    expect((await locks.acquire(base(t, r1, t.agents[0]!, 'contact:peter@acme.com', 'COMMUNICATION'))).ok).toBe(true);
    expect((await locks.acquire(base(t, r2, t.agents[1]!, 'contact:peter@acme.com', 'COMMUNICATION'))).ok).toBe(false);
  });

  it('leases expire and are reclaimed; a heartbeat keeps a working run alive', async () => {
    const t = await tenant();
    const [r1, r2] = [await run(t), await run(t, t.agents[1])];
    await locks.acquire(base(t, r1, t.agents[0]!, 'crm:account:2', 'EXCLUSIVE_WRITE', { leaseMs: 1 }));
    await new Promise((r) => setTimeout(r, 15));
    expect((await locks.acquire(base(t, r2, t.agents[1]!, 'crm:account:2', 'EXCLUSIVE_WRITE'))).ok).toBe(true); // reclaimed

    const r3 = await run(t, t.agents[2]);
    await locks.acquire(base(t, r3, t.agents[2]!, 'crm:account:3', 'EXCLUSIVE_WRITE', { leaseMs: 60 }));
    expect(await locks.heartbeat(t.tenantId, r3, 60_000)).toBe(1);
    await new Promise((r) => setTimeout(r, 80));
    expect((await locks.acquire(base(t, r1, t.agents[0]!, 'crm:account:3', 'EXCLUSIVE_WRITE'))).ok).toBe(false); // still held
  });

  it('terminating a run releases everything it held', async () => {
    const t = await tenant();
    const [r1, r2] = [await run(t), await run(t, t.agents[1])];
    await locks.acquire(base(t, r1, t.agents[0]!, 'a', 'EXCLUSIVE_WRITE'));
    await locks.acquire(base(t, r1, t.agents[0]!, 'b', 'EXCLUSIVE_WRITE'));
    expect(await locks.releaseAllForRun(t.tenantId, r1)).toBe(2);
    expect((await locks.acquire(base(t, r2, t.agents[1]!, 'a', 'EXCLUSIVE_WRITE'))).ok).toBe(true);
  });

  it('★ a two-run wait cycle is broken deterministically: the LOWER-risk run yields', async () => {
    const t = await tenant();
    const [hi, lo] = [await run(t, t.agents[0], new Date(Date.now() - 10_000)), await run(t, t.agents[1])];
    expect((await locks.acquire(base(t, hi, t.agents[0]!, 'crm:account:A', 'EXCLUSIVE_WRITE', { riskTier: 'HIGH' }))).ok).toBe(true);
    expect((await locks.acquire(base(t, lo, t.agents[1]!, 'crm:account:B', 'EXCLUSIVE_WRITE', { riskTier: 'LOW' }))).ok).toBe(true);
    // hi now wants B (held by lo) — blocked, no cycle yet
    const first = await locks.acquire(base(t, hi, t.agents[0]!, 'crm:account:B', 'EXCLUSIVE_WRITE', { riskTier: 'HIGH' }));
    expect(first).toMatchObject({ ok: false, victim: false });
    // lo wants A (held by hi): the cycle closes, and lo — lower risk — is the victim
    const second = await locks.acquire(base(t, lo, t.agents[1]!, 'crm:account:A', 'EXCLUSIVE_WRITE', { riskTier: 'LOW' }));
    expect(second).toMatchObject({ ok: false, victim: true });
    // the victim's locks are released, so the winner proceeds on its next try
    expect((await locks.acquire(base(t, hi, t.agents[0]!, 'crm:account:B', 'EXCLUSIVE_WRITE', { riskTier: 'HIGH' }))).ok).toBe(true);
    expect((await locks.activity(t.tenantId, 'crm:account:B')).waiters).toEqual([]);
  });

  it('★ equal risk: the run that started LATER yields (ties broken by start time)', async () => {
    const t = await tenant();
    const [older, newer] = [await run(t, t.agents[0], new Date(Date.now() - 60_000)), await run(t, t.agents[1])];
    await locks.acquire(base(t, older, t.agents[0]!, 'x:1', 'EXCLUSIVE_WRITE', { riskTier: 'MEDIUM' }));
    await locks.acquire(base(t, newer, t.agents[1]!, 'x:2', 'EXCLUSIVE_WRITE', { riskTier: 'MEDIUM' }));
    await locks.acquire(base(t, older, t.agents[0]!, 'x:2', 'EXCLUSIVE_WRITE', { riskTier: 'MEDIUM' }));
    const r = await locks.acquire(base(t, newer, t.agents[1]!, 'x:1', 'EXCLUSIVE_WRITE', { riskTier: 'MEDIUM' }));
    expect(r).toMatchObject({ ok: false, victim: true });
  });

  it('★ a cycle whose victim never retries is still broken by the sweep within the bound', async () => {
    const t = await tenant();
    const [a, b] = [await run(t, t.agents[0], new Date(Date.now() - 1000)), await run(t, t.agents[1])];
    await locks.acquire(base(t, a, t.agents[0]!, 'p:1', 'EXCLUSIVE_WRITE', { riskTier: 'HIGH' }));
    await locks.acquire(base(t, b, t.agents[1]!, 'p:2', 'EXCLUSIVE_WRITE', { riskTier: 'LOW' }));
    // both block, but each goes quiet before the cycle is observed by an acquire() call
    await pool.query(`INSERT INTO entity_lock_waits (tenant_id, entity_key, mode, waiting_run_id, waiting_agent_id, risk_tier, waiting_since) VALUES ($1,'p:2','EXCLUSIVE_WRITE',$2,$3,'HIGH', now() - interval '10 seconds')`, [t.tenantId, a, t.agents[0]]);
    await pool.query(`INSERT INTO entity_lock_waits (tenant_id, entity_key, mode, waiting_run_id, waiting_agent_id, risk_tier, waiting_since) VALUES ($1,'p:1','EXCLUSIVE_WRITE',$2,$3,'LOW', now() - interval '10 seconds')`, [t.tenantId, b, t.agents[1]]);
    expect(await locks.sweepDeadlocks(t.tenantId, 5_000)).toEqual({ cycles: 1, yielded: [b] });
    expect((await locks.list(t.tenantId)).map((l) => l.runId)).toEqual([a]);
    // a younger, un-stuck wait is left alone
    expect((await locks.sweepDeadlocks(t.tenantId, 5_000)).cycles).toBe(0);
  });

  it('★ p99 acquisition < 50 ms on uncontended entities', async () => {
    const t = await tenant();
    const r = await run(t);
    const times: number[] = [];
    for (let i = 0; i < 150; i++) {
      const s = performance.now();
      const res = await locks.acquire(base(t, r, t.agents[0]!, `crm:account:perf-${i}`, 'EXCLUSIVE_WRITE'));
      times.push(performance.now() - s);
      expect(res.ok).toBe(true);
    }
    times.sort((x, y) => x - y);
    const p99 = times[Math.floor(times.length * 0.99)]!;
    expect(p99, `p99 ${p99.toFixed(1)} ms`).toBeLessThan(50);
  });

  it('★ multi-agent chaos: 20 agents race for one entity — never two holders, and everyone eventually gets a turn', async () => {
    const t = await tenant(20);
    const runs = await Promise.all(t.agents.map((a) => run(t, a)));
    const entity = 'crm:account:chaos';
    let holders = 0;
    let maxHolders = 0;
    const done: number[] = [];

    await Promise.all(
      runs.map(async (runId, i) => {
        for (let attempt = 0; attempt < 400; attempt++) {
          const res = await locks.acquire({ tenantId: t.tenantId, entityKey: entity, mode: 'EXCLUSIVE_WRITE', runId, agentId: t.agents[i]!, intent: `agent ${i}`, riskTier: 'MEDIUM' });
          if (res.ok) {
            holders++;
            maxHolders = Math.max(maxHolders, holders);
            await new Promise((r) => setTimeout(r, 2)); // the "work"
            holders--;
            await locks.release(t.tenantId, res.lockId);
            done.push(i);
            return;
          }
          await new Promise((r) => setTimeout(r, 1 + Math.random() * 4));
        }
        throw new Error(`agent ${i} starved`);
      }),
    );
    expect(maxHolders).toBe(1);
    expect(done.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    const rows = (await pool.query(`SELECT count(*)::int n FROM entity_locks WHERE tenant_id = $1 AND entity_key = $2`, [t.tenantId, entity])).rows[0];
    expect(rows.n).toBe(0);
  });

  it('"who else is on this account" is accurate under concurrent load (§10.4)', async () => {
    const t = await tenant(6);
    const runs = await Promise.all(t.agents.map((a) => run(t, a)));
    const entity = 'crm:account:who';
    const results = await Promise.all(runs.map((r, i) => locks.acquire({ tenantId: t.tenantId, entityKey: entity, mode: 'EXCLUSIVE_WRITE', runId: r, agentId: t.agents[i]!, intent: `intent ${i}`, riskTier: 'LOW' })));
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    const act = await locks.activity(t.tenantId, entity);
    expect(act.holders).toHaveLength(1);
    expect(act.holders[0]).toMatchObject({ mode: 'EXCLUSIVE_WRITE', intent: expect.stringMatching(/^intent \d$/) });
    expect(act.waiters).toHaveLength(5);
    expect(new Set(act.waiters.map((w) => w.runId)).size).toBe(5);
  });

  it('★ an admin override needs a reason, is audited, and names what it broke (§18)', async () => {
    const t = await tenant();
    const r = await run(t);
    const got = await locks.acquire(base(t, r, t.agents[0]!, 'crm:account:stuck', 'EXCLUSIVE_WRITE'));
    if (!got.ok) throw new Error('setup');
    await expect(locks.adminRelease(t.tenantId, got.lockId, t.userId, '  ')).rejects.toThrow(/reason/);
    expect(await locks.adminRelease(t.tenantId, got.lockId, t.userId, 'agent hung; customer waiting')).toBe(true);
    const ev = (await pool.query(`SELECT payload FROM platform_events WHERE tenant_id = $1 AND kind = 'lock.admin_released'`, [t.tenantId])).rows[0].payload;
    expect(ev).toMatchObject({ entityKey: 'crm:account:stuck', reason: 'agent hung; customer waiting', heldByRun: r });
  });
});

describe('contact ledger (§10.2)', () => {
  const ledger = new ContactLedger();
  const attempt = (t: T, identity: string, runId: string, agent: string, extra: Partial<Parameters<ContactLedger['attempt']>[0]> = {}) => ({ tenantId: t.tenantId, identity, channel: 'email' as const, runId, agentId: agent, onBehalfOf: t.userId, relationship: 'prospect' as const, ...extra });

  it('identities are normalized aggressively: plus-tags, case, Gmail dots and aliases are one person', () => {
    expect(normalizeIdentity('Peter.Smith+news@GoogleMail.com')).toBe('petersmith@gmail.com');
    expect(normalizeIdentity('  "Peter" <PETER@Acme.com> ')).toBe('peter@acme.com');
    expect(normalizeIdentity('mailto:Peter+x@acme.com')).toBe('peter@acme.com');
    expect(normalizeIdentity('@PeterS')).toBe('@peters');
  });

  it('★ a second agent inside the cooldown is blocked and told who holds the relationship', async () => {
    const t = await tenant();
    const [r1, r2] = [await run(t), await run(t, t.agents[1])];
    const first = await ledger.attempt(attempt(t, 'peter@acme.com', r1, t.agents[0]!, { at: new Date(Date.now() - 6 * 3_600_000) }));
    expect(first.ok).toBe(true);
    const second = await ledger.attempt(attempt(t, 'Peter+qbr@Acme.com', r2, t.agents[1]!));
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.blockedBy).toMatchObject({ agentId: t.agents[0], runId: r1, onBehalfOf: t.userId, relationship: 'prospect' });
    expect(second.message).toMatch(/6 hours ago/);
    expect(second.message).toMatch(/Cooldown ends in 4 days/);
  });

  it('cooldowns follow the relationship: prospect 5 days, client 1 day, internal none', async () => {
    const t = await tenant();
    const [r1, r2] = [await run(t), await run(t, t.agents[1])];
    const day = 86_400_000;
    const sent = new Date(Date.now() - 2 * day);
    await ledger.attempt(attempt(t, 'p@x.example', r1, t.agents[0]!, { relationship: 'prospect', at: sent }));
    await ledger.attempt(attempt(t, 'c@x.example', r1, t.agents[0]!, { relationship: 'client', at: sent }));
    await ledger.attempt(attempt(t, 'i@x.example', r1, t.agents[0]!, { relationship: 'internal', at: sent }));
    expect((await ledger.attempt(attempt(t, 'p@x.example', r2, t.agents[1]!, { relationship: 'prospect' }))).ok).toBe(false);
    expect((await ledger.attempt(attempt(t, 'c@x.example', r2, t.agents[1]!, { relationship: 'client' }))).ok).toBe(true);
    expect((await ledger.attempt(attempt(t, 'i@x.example', r2, t.agents[1]!, { relationship: 'internal' }))).ok).toBe(true);
    expect(DEFAULT_COOLDOWN_MS).toMatchObject({ prospect: 5 * day, client: day, internal: 0 });
  });

  it('after the cooldown it is allowed again', async () => {
    const t = await tenant();
    const [r1, r2] = [await run(t), await run(t, t.agents[1])];
    await ledger.attempt(attempt(t, 'old@x.example', r1, t.agents[0]!, { at: new Date(Date.now() - 6 * 86_400_000) }));
    expect((await ledger.attempt(attempt(t, 'old@x.example', r2, t.agents[1]!))).ok).toBe(true);
  });

  it('one run contacting the same person twice is not blocked by itself', async () => {
    const t = await tenant();
    const r = await run(t);
    expect((await ledger.attempt(attempt(t, 'same@x.example', r, t.agents[0]!))).ok).toBe(true);
    expect((await ledger.attempt(attempt(t, 'same@x.example', r, t.agents[0]!))).ok).toBe(true);
  });

  it('★ ZERO duplicates inside cooldown under a 20-way race for one human', async () => {
    const t = await tenant(20);
    const runs = await Promise.all(t.agents.map((a) => run(t, a)));
    const results = await Promise.all(runs.map((r, i) => ledger.attempt(attempt(t, 'target@acme.com', r, t.agents[i]!))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const rows = (await pool.query(`SELECT count(*)::int n FROM contact_ledger WHERE tenant_id = $1 AND external_identity = 'target@acme.com'`, [t.tenantId])).rows[0];
    expect(rows.n).toBe(1);
  });

  it('an override needs a reason, is stamped on the ledger row, and is audited (§18)', async () => {
    const t = await tenant();
    const [r1, r2] = [await run(t), await run(t, t.agents[1])];
    await ledger.attempt(attempt(t, 'vip@x.example', r1, t.agents[0]!));
    await expect(ledger.override({ ...attempt(t, 'vip@x.example', r2, t.agents[1]!), by: t.userId, reason: '' })).rejects.toThrow(/reason/);
    const o = await ledger.override({ ...attempt(t, 'vip@x.example', r2, t.agents[1]!), by: t.userId, reason: 'contract deadline today' });
    const hist = await ledger.history(t.tenantId, 'VIP@x.example');
    expect(hist.find((h) => h.id === o.ledgerId)).toMatchObject({ overrideReason: 'contract deadline today', overriddenBy: t.userId });
    expect((await pool.query(`SELECT 1 FROM platform_events WHERE tenant_id = $1 AND kind = 'contact.override'`, [t.tenantId])).rowCount).toBe(1);
  });

  it('★ an override actually lets the overridden run through — and only that run', async () => {
    const t = await tenant();
    const [r1, r2, r3] = [await run(t), await run(t, t.agents[1]), await run(t, t.agents[2])];
    expect((await ledger.attempt(attempt(t, 'deal@x.example', r1, t.agents[0]!))).ok).toBe(true);
    // blocked before the override, by the early (read-only) check and by the atomic one
    expect(await ledger.check(t.tenantId, 'deal@x.example', undefined, r2)).not.toBeNull();
    expect((await ledger.attempt(attempt(t, 'deal@x.example', r2, t.agents[1]!))).ok).toBe(false);
    await ledger.override({ ...attempt(t, 'deal@x.example', r2, t.agents[1]!), by: t.userId, reason: 'renewal closes today' });
    expect(await ledger.check(t.tenantId, 'deal@x.example', undefined, r2)).toBeNull();
    expect((await ledger.attempt(attempt(t, 'deal@x.example', r2, t.agents[1]!))).ok).toBe(true);
    // a third run is not exempted by someone else's override
    expect((await ledger.attempt(attempt(t, 'deal@x.example', r3, t.agents[2]!))).ok).toBe(false);
  });

  it('the ledger is append-only: not even the application role can edit history', async () => {
    const t = await tenant();
    const r = await run(t);
    await ledger.attempt(attempt(t, 'h@x.example', r, t.agents[0]!));
    const app = new pg.Pool({ connectionString: process.env['DATABASE_APP_URL'] ?? 'postgresql://vega_app:vega_app_local_dev_only@localhost:5432/vega' });
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('vega.tenant_id', $1, true)`, [t.tenantId]);
      await expect(c.query(`UPDATE contact_ledger SET cooldown_until = now()`)).rejects.toThrow(/permission denied/);
    } finally {
      await c.query('ROLLBACK');
      c.release();
      await app.end();
    }
  });
});

describe('write reconciliation (§10.3)', () => {
  const rec = new WriteReconciler({ tags: union });
  const decl = (t: T, runId: string, agent: string, entityKey: string, field: string, value: unknown, riskTier = 'LOW') => rec.declare({ tenantId: t.tenantId, entityKey, field, runId, agentId: agent, value, riskTier });

  it('a lone write proceeds', async () => {
    const t = await tenant();
    expect(await decl(t, await run(t), t.agents[0]!, 'crm:account:9', 'owner', 'sarah')).toMatchObject({ action: 'proceed' });
  });

  it('different fields of one entity never conflict', async () => {
    const t = await tenant();
    const [r1, r2] = [await run(t), await run(t, t.agents[1])];
    expect((await decl(t, r1, t.agents[0]!, 'crm:account:9', 'owner', 'sarah')).action).toBe('proceed');
    expect((await decl(t, r2, t.agents[1]!, 'crm:account:9', 'stage', 'won')).action).toBe('proceed');
  });

  it('identical values merge trivially; a merge rule merges the rest (set union of tags)', async () => {
    const t = await tenant();
    const [r1, r2] = [await run(t), await run(t, t.agents[1])];
    await decl(t, r1, t.agents[0]!, 'e:1', 'status', 'active');
    expect(await decl(t, r2, t.agents[1]!, 'e:1', 'status', 'active')).toMatchObject({ action: 'merged', value: 'active' });
    const [r3, r4] = [await run(t), await run(t, t.agents[1])];
    await decl(t, r3, t.agents[0]!, 'e:2', 'tags', ['vip']);
    const merged = await decl(t, r4, t.agents[1]!, 'e:2', 'tags', ['renewal', 'vip']);
    expect(merged).toMatchObject({ action: 'merged' });
    expect([...(merged as { value: string[] }).value].sort()).toEqual(['renewal', 'vip']);
  });

  it('★ last-write-wins is never the answer: a conflict is detected pre-commit and the lower-priority write DEFERS', async () => {
    const t = await tenant();
    const [high, low] = [await run(t), await run(t, t.agents[1])];
    expect((await decl(t, low, t.agents[1]!, 'e:3', 'amount', 100, 'LOW')).action).toBe('proceed');
    const out = await decl(t, high, t.agents[0]!, 'e:3', 'amount', 250, 'MEDIUM');
    expect(out).toMatchObject({ action: 'proceed' }); // the higher-priority write wins the field
    const again = await decl(t, low, t.agents[1]!, 'e:3', 'amount', 100, 'LOW');
    expect(again).toMatchObject({ action: 'defer', winner: { run_id: high } });
  });

  it('two high-stakes writes go to a person with both proposals shown side by side', async () => {
    const t = await tenant();
    const [r1, r2] = [await run(t), await run(t, t.agents[1])];
    await decl(t, r1, t.agents[0]!, 'e:4', 'owner', 'sarah', 'HIGH');
    const out = await decl(t, r2, t.agents[1]!, 'e:4', 'owner', 'dave', 'HIGH');
    expect(out).toMatchObject({ action: 'escalate' });
    if (out.action !== 'escalate') return;
    expect(out.proposals.map((p) => p.value).sort()).toEqual(['dave', 'sarah']);
    expect((await rec.open(t.tenantId)).map((c) => c.id)).toContain(out.conflictId);
    const picked = await rec.resolve(t.tenantId, out.conflictId, t.userId, r1);
    expect(picked).toMatchObject({ value: 'sarah' });
    expect(await rec.resolve(t.tenantId, 'ffffffff-ffff-4fff-8fff-ffffffffffff', t.userId, r1)).toBeNull();
  });

  it('a completed write clears its in-flight intent', async () => {
    const t = await tenant();
    const [r1, r2] = [await run(t), await run(t, t.agents[1])];
    const first = await decl(t, r1, t.agents[0]!, 'e:5', 'owner', 'sarah');
    if (first.action !== 'proceed') throw new Error('setup');
    await rec.complete(t.tenantId, first.intentId);
    expect((await decl(t, r2, t.agents[1]!, 'e:5', 'owner', 'dave')).action).toBe('proceed');
  });

  it('is isolated per tenant', async () => {
    const [a, b] = [await tenant(), await tenant()];
    await decl(a, await run(a), a.agents[0]!, 'e:shared', 'owner', 'x');
    expect((await decl(b, await run(b), b.agents[0]!, 'e:shared', 'owner', 'y')).action).toBe('proceed');
    void randomUUID;
  });
});
