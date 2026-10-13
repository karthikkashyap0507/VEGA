import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { schema, withTenant } from '@vega/db';

/**
 * ENTITY LOCKS — docs/module10.md §10.1. Advisory locks on BUSINESS ENTITIES (`crm:account:8812`,
 * `contact:peter@acme.com`), not database rows: the contention is semantic.
 *
 *   SHARED_READ      many readers; blocked only while another run holds EXCLUSIVE_WRITE
 *   EXCLUSIVE_WRITE  one writer per entity; blocked by other runs' readers too
 *   COMMUNICATION    one agent contacts a given human at a time
 *
 * The row is the arbiter (PROJECT.md D-15, same lesson as holds): correctness comes from the
 * `entity_locks` unique index plus a per-entity transaction advisory lock, never from an
 * in-process mutex. `acquire` never blocks a connection — it answers immediately, and a blocked
 * caller is recorded in `entity_lock_waits`, which is what makes a wait CYCLE observable.
 * Cycles are broken deterministically: the lower-risk run yields, ties by run start (§10.1).
 */
export type LockMode = 'SHARED_READ' | 'EXCLUSIVE_WRITE' | 'COMMUNICATION';

export interface AcquireInput {
  tenantId: string;
  entityKey: string;
  mode: LockMode;
  runId: string;
  agentId: string;
  /** Human-readable: "sending quarterly review" (§9). */
  intent: string;
  riskTier?: string | null;
  leaseMs?: number;
}

export type AcquireResult =
  | { ok: true; lockId: string; reentrant: boolean; leaseExpiresAt: Date }
  | { ok: false; victim: false; heldBy: Holder }
  | { ok: false; victim: true; reason: string; heldBy: Holder };

export interface Holder {
  runId: string;
  agentId: string;
  mode: LockMode;
  intent: string;
  acquiredAt: Date;
  leaseExpiresAt: Date;
}

export interface Activity {
  entityKey: string;
  holders: Array<Holder & { lockId: string }>;
  waiters: Array<{ runId: string; agentId: string; mode: LockMode; riskTier: string | null; waitingSince: Date }>;
}

const RISK_RANK: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const rank = (t: string | null | undefined) => RISK_RANK[t ?? 'LOW'] ?? 0;

export const DEFAULT_LEASE_MS = 5 * 60_000;
/** §10.1 / §20: no deadlock persists beyond this. */
export const DEADLOCK_BOUND_MS = 5_000;

const conflictsWith = (want: LockMode, held: LockMode): boolean => {
  if (want === 'COMMUNICATION') return held === 'COMMUNICATION';
  if (want === 'EXCLUSIVE_WRITE') return held === 'EXCLUSIVE_WRITE' || held === 'SHARED_READ';
  return held === 'EXCLUSIVE_WRITE';
};

export class LockManager {
  constructor(private readonly now: () => Date = () => new Date()) {}

  async acquire(i: AcquireInput): Promise<AcquireResult> {
    const lease = new Date(this.now().getTime() + (i.leaseMs ?? DEFAULT_LEASE_MS));
    const result = await withTenant(i.tenantId, async (db) => {
      // One writer at a time per entity decides everything below, even across processes.
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${i.tenantId}:${i.entityKey}`}))`);
      await db.delete(schema.entityLocks).where(and(eq(schema.entityLocks.entityKey, i.entityKey), lt(schema.entityLocks.leaseExpiresAt, this.now())));
      const held = await db.select().from(schema.entityLocks).where(eq(schema.entityLocks.entityKey, i.entityKey));

      const mine = held.find((l) => l.holderRunId === i.runId && l.mode === i.mode);
      if (mine) {
        await db.update(schema.entityLocks).set({ leaseExpiresAt: lease, intent: i.intent }).where(eq(schema.entityLocks.id, mine.id));
        return { ok: true as const, lockId: mine.id, reentrant: true, leaseExpiresAt: lease };
      }
      const blockers = held.filter((l) => l.holderRunId !== i.runId && conflictsWith(i.mode, l.mode as LockMode));
      if (!blockers.length) {
        const [row] = await db
          .insert(schema.entityLocks)
          .values({ tenantId: i.tenantId, entityKey: i.entityKey, mode: i.mode, holderRunId: i.runId, holderAgentId: i.agentId, intent: i.intent, riskTier: i.riskTier ?? null, acquiredAt: this.now(), leaseExpiresAt: lease })
          .returning({ id: schema.entityLocks.id });
        await db.delete(schema.entityLockWaits).where(and(eq(schema.entityLockWaits.waitingRunId, i.runId), eq(schema.entityLockWaits.entityKey, i.entityKey)));
        return { ok: true as const, lockId: row!.id, reentrant: false, leaseExpiresAt: lease };
      }
      await db
        .insert(schema.entityLockWaits)
        .values({ tenantId: i.tenantId, entityKey: i.entityKey, mode: i.mode, waitingRunId: i.runId, waitingAgentId: i.agentId, riskTier: i.riskTier ?? null, waitingSince: this.now() })
        .onConflictDoNothing();
      const b = blockers[0]!;
      return {
        ok: false as const,
        heldBy: { runId: b.holderRunId, agentId: b.holderAgentId, mode: b.mode as LockMode, intent: b.intent, acquiredAt: b.acquiredAt, leaseExpiresAt: b.leaseExpiresAt } satisfies Holder,
      };
    });
    if (result.ok) return result;

    // Blocked. Is this a wait CYCLE, and am I the one who yields?
    const broke = await this.breakCycles(i.tenantId, 0);
    if (broke.yielded.includes(i.runId)) {
      return { ok: false, victim: true, reason: 'deadlock: this run yielded to a higher-priority run holding what it needs', heldBy: result.heldBy };
    }
    // The cycle may have been broken in my favour (the OTHER run yielded): try once more.
    if (broke.yielded.length) return this.acquire(i);
    return { ok: false, victim: false, heldBy: result.heldBy };
  }

  /**
   * Finds wait-for cycles among blocked runs and breaks each one by making the victim yield:
   * its waits are deleted AND its held locks released, so the cycle cannot re-form. Called on
   * every blocked acquisition (self-healing — no scheduler needed for the §10.1 bound) and by
   * `sweepDeadlocks` for waiters that never retry.
   */
  async breakCycles(tenantId: string, olderThanMs: number): Promise<{ cycles: number; yielded: string[] }> {
    return withTenant(tenantId, async (db) => {
      const cutoff = new Date(this.now().getTime() - olderThanMs);
      const waits = (await db.select().from(schema.entityLockWaits)).filter((w) => w.waitingSince <= cutoff);
      if (!waits.length) return { cycles: 0, yielded: [] };
      const locks = await db.select().from(schema.entityLocks);
      // edge: waiting run → run(s) currently holding a conflicting lock on what it waits for
      const edges = new Map<string, Set<string>>();
      for (const w of waits) {
        for (const l of locks) {
          if (l.entityKey === w.entityKey && l.holderRunId !== w.waitingRunId && conflictsWith(w.mode as LockMode, l.mode as LockMode)) {
            edges.set(w.waitingRunId, (edges.get(w.waitingRunId) ?? new Set()).add(l.holderRunId));
          }
        }
      }
      const cycles: string[][] = [];
      const seen = new Set<string>();
      const dfs = (node: string, path: string[]) => {
        const at = path.indexOf(node);
        if (at >= 0) {
          const cyc = path.slice(at);
          const key = [...cyc].sort().join('|');
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push(cyc);
          }
          return;
        }
        for (const next of edges.get(node) ?? []) dfs(next, [...path, node]);
      };
      for (const start of edges.keys()) dfs(start, []);
      if (!cycles.length) return { cycles: 0, yielded: [] };

      const runs = await db.select({ id: schema.runs.id, startedAt: schema.runs.startedAt }).from(schema.runs).where(inArray(schema.runs.id, [...new Set(cycles.flat())]));
      const started = new Map(runs.map((r) => [r.id, r.startedAt.getTime()]));
      const riskOf = (runId: string) => {
        const w = waits.find((x) => x.waitingRunId === runId);
        const l = locks.find((x) => x.holderRunId === runId);
        return rank(w?.riskTier ?? l?.riskTier);
      };
      const yielded: string[] = [];
      for (const cyc of cycles) {
        if (cyc.some((r) => yielded.includes(r))) continue; // an earlier victim already broke this cycle
        // lower risk yields; tie → the run that started later yields (it has invested least)
        const victim = [...cyc].sort((a, b) => riskOf(a) - riskOf(b) || (started.get(b) ?? 0) - (started.get(a) ?? 0) || (a < b ? -1 : 1))[0]!;
        await db.delete(schema.entityLockWaits).where(eq(schema.entityLockWaits.waitingRunId, victim));
        await db.delete(schema.entityLocks).where(eq(schema.entityLocks.holderRunId, victim));
        yielded.push(victim);
      }
      return { cycles: cycles.length, yielded };
    });
  }

  /** Waiters older than the §10.1 bound that are part of a cycle are broken even if they never retry. */
  sweepDeadlocks(tenantId: string, olderThanMs = DEADLOCK_BOUND_MS) {
    return this.breakCycles(tenantId, olderThanMs);
  }

  async release(tenantId: string, lockId: string): Promise<boolean> {
    return withTenant(tenantId, async (db) => (await db.delete(schema.entityLocks).where(eq(schema.entityLocks.id, lockId)).returning({ id: schema.entityLocks.id })).length > 0);
  }

  /** Automatic release on run termination (§10.1). */
  async releaseAllForRun(tenantId: string, runId: string): Promise<number> {
    return withTenant(tenantId, async (db) => {
      await db.delete(schema.entityLockWaits).where(eq(schema.entityLockWaits.waitingRunId, runId));
      return (await db.delete(schema.entityLocks).where(eq(schema.entityLocks.holderRunId, runId)).returning({ id: schema.entityLocks.id })).length;
    });
  }

  /** Lease heartbeat for a run that is still working. */
  async heartbeat(tenantId: string, runId: string, leaseMs = DEFAULT_LEASE_MS): Promise<number> {
    const lease = new Date(this.now().getTime() + leaseMs);
    return withTenant(tenantId, async (db) => (await db.update(schema.entityLocks).set({ leaseExpiresAt: lease }).where(eq(schema.entityLocks.holderRunId, runId)).returning({ id: schema.entityLocks.id })).length);
  }

  /** Admin override (§18): requires a reason, and is recorded as a platform event. */
  async adminRelease(tenantId: string, lockId: string, by: string, reason: string): Promise<boolean> {
    if (!reason.trim()) throw new Error('a lock override needs a reason');
    return withTenant(tenantId, async (db) => {
      const [row] = await db.delete(schema.entityLocks).where(eq(schema.entityLocks.id, lockId)).returning();
      if (!row) return false;
      await db.insert(schema.platformEvents).values({ tenantId, actorId: by, kind: 'lock.admin_released', payload: { lockId, entityKey: row.entityKey, mode: row.mode, heldByRun: row.holderRunId, heldByAgent: row.holderAgentId, intent: row.intent, reason } });
      return true;
    });
  }

  /** "Who else is on this account" (§10.4): every agent currently acting on an entity, and who is waiting. */
  async activity(tenantId: string, entityKey: string): Promise<Activity> {
    return withTenant(tenantId, async (db) => {
      const now = this.now();
      const locks = (await db.select().from(schema.entityLocks).where(eq(schema.entityLocks.entityKey, entityKey))).filter((l) => l.leaseExpiresAt > now);
      const waits = await db.select().from(schema.entityLockWaits).where(eq(schema.entityLockWaits.entityKey, entityKey));
      return {
        entityKey,
        holders: locks.map((l) => ({ lockId: l.id, runId: l.holderRunId, agentId: l.holderAgentId, mode: l.mode as LockMode, intent: l.intent, acquiredAt: l.acquiredAt, leaseExpiresAt: l.leaseExpiresAt })),
        waiters: waits.map((w) => ({ runId: w.waitingRunId, agentId: w.waitingAgentId, mode: w.mode as LockMode, riskTier: w.riskTier, waitingSince: w.waitingSince })),
      };
    });
  }

  async list(tenantId: string): Promise<Array<Holder & { lockId: string; entityKey: string }>> {
    return withTenant(tenantId, async (db) => {
      const now = this.now();
      return (await db.select().from(schema.entityLocks).orderBy(schema.entityLocks.acquiredAt))
        .filter((l) => l.leaseExpiresAt > now)
        .map((l) => ({ lockId: l.id, entityKey: l.entityKey, runId: l.holderRunId, agentId: l.holderAgentId, mode: l.mode as LockMode, intent: l.intent, acquiredAt: l.acquiredAt, leaseExpiresAt: l.leaseExpiresAt }));
    });
  }
}
