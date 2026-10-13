import { and, eq, isNull } from 'drizzle-orm';
import { schema, withTenant } from '@vega/db';

/**
 * WRITE RECONCILIATION — docs/module10.md §10.3. Last-write-wins is unacceptable. A write is
 * DECLARED before it commits; if another run has declared a different value for the same
 * (entity, field) and has not finished, the conflict is detected PRE-commit and resolved by:
 *
 *   1. merge by policy — identical values, or a merge rule exists for the field
 *   2. escalate — either side is HIGH/CRITICAL, or no priority separates them: a person decides,
 *      with both proposals shown side by side (the `write_conflicts` row carries them)
 *   3. defer and replan — the lower-priority write yields and replans against the new state
 *
 * Different fields of one entity never conflict (they merge by construction).
 */
export interface Proposal {
  run_id: string;
  agent_id: string;
  value: unknown;
  risk_tier: string | null;
  at: string;
}

export type MergeRule = (values: unknown[]) => unknown | undefined;

export type Outcome =
  | { action: 'proceed'; intentId: string }
  | { action: 'merged'; conflictId: string; value: unknown }
  | { action: 'defer'; conflictId: string; winner: Proposal; message: string }
  | { action: 'escalate'; conflictId: string; proposals: Proposal[]; message: string };

const RANK: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const rank = (t: string | null | undefined) => RANK[t ?? 'LOW'] ?? 0;

export const union: MergeRule = (values) => {
  if (!values.every(Array.isArray)) return undefined;
  return [...new Set((values as unknown[][]).flat().map((v) => JSON.stringify(v)))].map((s) => JSON.parse(s) as unknown);
};

export class WriteReconciler {
  constructor(
    private readonly mergeRules: Record<string, MergeRule> = {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** A run declares it is about to write `field` of `entityKey`. */
  async declare(i: { tenantId: string; entityKey: string; field: string; runId: string; agentId: string; value: unknown; riskTier?: string | null }): Promise<Outcome> {
    const mine: Proposal = { run_id: i.runId, agent_id: i.agentId, value: i.value, risk_tier: i.riskTier ?? null, at: this.now().toISOString() };
    return withTenant(i.tenantId, async (db) => {
      const pending = (
        await db.select().from(schema.writeConflicts).where(and(eq(schema.writeConflicts.entityKey, i.entityKey), eq(schema.writeConflicts.field, i.field), isNull(schema.writeConflicts.closedAt)))
      )[0];
      if (!pending) {
        const [row] = await db.insert(schema.writeConflicts).values({ tenantId: i.tenantId, entityKey: i.entityKey, field: i.field, proposals: [mine] }).returning({ id: schema.writeConflicts.id });
        return { action: 'proceed' as const, intentId: row!.id };
      }
      const proposals = pending.proposals as Proposal[];
      const others = proposals.filter((p) => p.run_id !== i.runId);
      if (!others.length) return { action: 'proceed' as const, intentId: pending.id }; // my own earlier declaration
      const all = [...proposals.filter((p) => p.run_id !== i.runId), mine];
      const same = all.every((p) => JSON.stringify(p.value) === JSON.stringify(all[0]!.value));
      const rule = this.mergeRules[i.field];
      const merged = same ? all[0]!.value : rule?.(all.map((p) => p.value));
      if (same || merged !== undefined) {
        await db.update(schema.writeConflicts).set({ proposals: all, resolution: 'merged' }).where(eq(schema.writeConflicts.id, pending.id));
        return { action: 'merged' as const, conflictId: pending.id, value: merged };
      }
      // A real conflict. Highest risk wins a deferral; two high-stakes writes go to a person.
      const ordered = [...all].sort((a, b) => rank(b.risk_tier) - rank(a.risk_tier) || a.at.localeCompare(b.at));
      const [first, second] = ordered;
      const stakes = Math.max(...all.map((p) => rank(p.risk_tier)));
      if (stakes >= 2 || rank(first!.risk_tier) === rank(second!.risk_tier)) {
        await db.update(schema.writeConflicts).set({ proposals: all, resolution: 'escalated' }).where(eq(schema.writeConflicts.id, pending.id));
        return { action: 'escalate' as const, conflictId: pending.id, proposals: all, message: `Two runs want to set ${i.entityKey} ${i.field} to different values; a person decides.` };
      }
      await db.update(schema.writeConflicts).set({ proposals: all, resolution: 'deferred' }).where(eq(schema.writeConflicts.id, pending.id));
      const winner = first!;
      return winner.run_id === i.runId
        ? { action: 'proceed' as const, intentId: pending.id } // I am the higher-priority write; the other will replan when it next declares
        : { action: 'defer' as const, conflictId: pending.id, winner, message: `A higher-priority write to ${i.entityKey} ${i.field} is in flight; replan against its result.` };
    });
  }

  /** The write committed (or its run ended): the in-flight intent is no longer a conflict. */
  async complete(tenantId: string, intentId: string): Promise<void> {
    await withTenant(tenantId, async (db) => {
      const [row] = await db.select().from(schema.writeConflicts).where(eq(schema.writeConflicts.id, intentId));
      if (!row || row.closedAt) return;
      // An intent nobody contended for leaves no trace; a real conflict keeps its history, closed.
      if (!row.resolution) await db.delete(schema.writeConflicts).where(eq(schema.writeConflicts.id, intentId));
      else await db.update(schema.writeConflicts).set({ closedAt: new Date() }).where(eq(schema.writeConflicts.id, intentId));
    });
  }

  /** Escalated conflicts still waiting for a person. */
  async open(tenantId: string) {
    return withTenant(tenantId, (db) =>
      db.select().from(schema.writeConflicts).where(and(eq(schema.writeConflicts.resolution, 'escalated'), isNull(schema.writeConflicts.resolvedBy))).orderBy(schema.writeConflicts.createdAt),
    );
  }

  async list(tenantId: string) {
    return withTenant(tenantId, (db) => db.select().from(schema.writeConflicts).orderBy(schema.writeConflicts.createdAt));
  }

  /** A person's decision on an escalated conflict: choose a winning proposal (the row keeps both). */
  async resolve(tenantId: string, conflictId: string, by: string, chosenRunId: string): Promise<{ value: unknown; winner: Proposal } | null> {
    return withTenant(tenantId, async (db) => {
      const [row] = await db.select().from(schema.writeConflicts).where(eq(schema.writeConflicts.id, conflictId));
      if (!row || row.resolution !== 'escalated') return null;
      const winner = (row.proposals as Proposal[]).find((p) => p.run_id === chosenRunId);
      if (!winner) return null;
      if (row.resolvedBy) return null; // already decided
      await db.update(schema.writeConflicts).set({ resolvedBy: by, closedAt: new Date() }).where(eq(schema.writeConflicts.id, conflictId));
      return { value: winner.value, winner };
    });
  }
}
