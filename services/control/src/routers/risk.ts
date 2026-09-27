import { desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Db } from '@vega/db';
import { Uuid } from '@vega/contracts';
import { problems } from '@vega/shared';
import { checkWeights, DEFAULT_WEIGHTS, scoreRisk, WEIGHT_BOUNDS, type RiskInput, type Tier, type Weights } from '@vega/risk';
import { emitEvent } from '../lib.js';
import { ProblemError, procedure, requireCapability, requireExposed, router } from '../trpc.js';
import { readable } from './runs.js';

/**
 * RISK (docs/module5.md §5.2, §6.3, §6.4, §7). The score is a transparent, versioned function —
 * never a model — so everything here is inspectable: the active weights and their bounds, a
 * dry-run score for a hypothetical action, a preview of how a weight change would move recent
 * actions between tiers, and every evaluation of a run with its factors (the explanation panel).
 *
 * Weights are data and never mutated: a change is a new version; history keeps the version it
 * was scored with, so replay (M7) recomputes with the recorded weights, not the current ones.
 */

const WeightsInput = z.object({
  w1: z.number(),
  w2: z.number(),
  w3: z.number(),
  w4: z.number(),
  w5: z.number(),
  w6: z.number(),
  w7: z.number(),
  boundaries: z.object({ low: z.number(), medium: z.number(), high: z.number() }),
});

const Taint = z.enum(['TRUSTED', 'ORG', 'UNTRUSTED']);
export const RiskInputSchema = z.object({
  sensitivity: z.number().int().min(0).max(100),
  labels: z.array(z.string().max(40)).max(20).default([]),
  effect: z.object({
    recipients: z.number().int().min(0).max(100_000),
    externalRecipients: z.number().int().min(0).max(100_000),
    recordsAffected: z.number().int().min(0).max(10_000_000),
    monetaryValue: z.object({ amount: z.number().min(0), currency: z.string().length(3) }).optional(),
  }),
  egressClass: z.enum(['INTERNAL', 'EXTERNAL', 'PUBLIC']),
  reversibility: z.enum(['R0', 'R1', 'R2', 'R3']),
  principalRole: z.enum(['OWNER', 'ADMIN', 'COMPLIANCE_OFFICER', 'WORKFLOW_OWNER', 'APPROVER', 'MEMBER', 'AUDITOR']),
  argTaint: Taint,
  recipientTaint: Taint,
  inScope: z.boolean(),
});

type WeightsRow = typeof schema.riskWeights.$inferSelect;
const toWeights = (w: WeightsRow): Weights => ({ version: w.version, ...(w.weights as Omit<Weights, 'version' | 'boundaries'>), boundaries: w.boundaries as Weights['boundaries'] });

/** The weights in force now: the tenant's newest, else the platform default. */
async function activeWeights(db: Db): Promise<{ weights: Weights; tenantOwned: boolean; activeFrom: string }> {
  const [w] = await db
    .select()
    .from(schema.riskWeights)
    .where(lte(schema.riskWeights.activeFrom, new Date()))
    .orderBy(sql`${schema.riskWeights.tenantId} IS NULL`, desc(schema.riskWeights.activeFrom), desc(schema.riskWeights.version))
    .limit(1);
  return w ? { weights: toWeights(w), tenantOwned: w.tenantId !== null, activeFrom: w.activeFrom.toISOString() } : { weights: DEFAULT_WEIGHTS, tenantOwned: false, activeFrom: new Date(0).toISOString() };
}

const TIERS: Tier[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export const riskRouter = router({
  weights: router({
    get: procedure.query(async ({ ctx }) => {
      requireCapability(ctx, 'policy.read');
      return ctx.db(async (db) => {
        const active = await activeWeights(db);
        const history = await db
          .select()
          .from(schema.riskWeights)
          .where(or(isNull(schema.riskWeights.tenantId), eq(schema.riskWeights.tenantId, ctx.principal.tenantId)))
          .orderBy(desc(schema.riskWeights.version))
          .limit(20);
        return { ...active, bounds: WEIGHT_BOUNDS, history: history.map((h) => ({ version: h.version, tenantOwned: h.tenantId !== null, weights: toWeights(h), activeFrom: h.activeFrom.toISOString(), authorId: h.authorId })) };
      });
    }),

    /** A new version; never a mutation. Bounded (§10): no weight can be zeroed or made to dominate. */
    put: procedure.input(WeightsInput).mutation(async ({ ctx, input }) => {
      requireCapability(ctx, 'policy.manage');
      requireExposed(ctx, 'policyAuthoring');
      const issues = checkWeights(input);
      if (issues.length) throw new ProblemError(problems.validation(issues.map((message) => ({ path: 'weights', message }))));
      return ctx.db(async (db) => {
        const before = await activeWeights(db);
        const { boundaries, ...w } = input;
        const [row] = await db.insert(schema.riskWeights).values({ tenantId: ctx.principal.tenantId, weights: w, boundaries, authorId: ctx.principal.userId }).returning();
        await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'risk.weights_changed', { from: before.weights.version, to: row!.version, weights: input });
        return { weights: toWeights(row!), tenantOwned: true, activeFrom: row!.activeFrom.toISOString() };
      });
    }),

    /** The live preview (§6.4): recent actions re-scored with candidate weights → tier shift. */
    preview: procedure.input(WeightsInput.extend({ days: z.number().int().min(1).max(90).default(30) })).query(async ({ ctx, input }) => {
      requireCapability(ctx, 'policy.read');
      const issues = checkWeights(input);
      if (issues.length) throw new ProblemError(problems.validation(issues.map((message) => ({ path: 'weights', message }))));
      const { days, boundaries, ...w } = input;
      const candidate: Weights = { version: 0, ...w, boundaries };
      return ctx.db(async (db) => {
        const rows = await db
          .select({ input: schema.riskEvaluations.inputJson, tier: schema.riskEvaluations.tier })
          .from(schema.riskEvaluations)
          .where(gte(schema.riskEvaluations.evaluatedAt, new Date(Date.now() - days * 86_400_000)))
          .orderBy(desc(schema.riskEvaluations.evaluatedAt))
          .limit(1000);
        const before = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<Tier, number>;
        const after = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<Tier, number>;
        let moved = 0;
        for (const r of rows) {
          const now = scoreRisk(r.input as RiskInput, candidate).tier;
          before[r.tier as Tier]++;
          after[now]++;
          if (now !== r.tier) moved++;
        }
        return { actions: rows.length, before, after, moved };
      });
    }),
  }),

  /** Dry-run scoring for a hypothetical action (§7 POST /v1/risk/score). Nothing is recorded. */
  score: procedure.input(z.object({ input: RiskInputSchema })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'policy.read');
    const { weights } = await ctx.db(activeWeights);
    return scoreRisk(input.input as RiskInput, weights);
  }),

  /** Every policy and risk evaluation of a run: the explanation panel and the audit view (§6.3). */
  evaluations: procedure.input(z.object({ runId: Uuid })).query(async ({ ctx, input }) => {
    const run = await readable(ctx, input.runId);
    return ctx.db(async (db) => {
      const evs = await db.select().from(schema.policyEvaluations).where(eq(schema.policyEvaluations.runId, run.id)).orderBy(schema.policyEvaluations.evaluatedAt);
      const riskIds = evs.map((e) => e.riskEvaluationId).filter((x): x is string => Boolean(x));
      const risks = riskIds.length ? await db.select().from(schema.riskEvaluations).where(inArray(schema.riskEvaluations.id, riskIds)) : [];
      return evs.map((e) => {
        const r = risks.find((x) => x.id === e.riskEvaluationId);
        const explanation = (r?.explanationJson as { explanation?: unknown[]; scoreTier?: string } | undefined) ?? {};
        return {
          id: e.id,
          nodeId: e.nodeId,
          dslNodeId: e.dslNodeId,
          toolId: e.toolId,
          decision: e.decision,
          approverRole: e.approverRole,
          holdWindowMs: e.holdWindowMs,
          decidedBy: { key: e.policyKey, version: e.policyVersion },
          bundleVersion: e.bundleVersion,
          preset: e.preset,
          failClosed: e.failClosed,
          chain: e.reasonJson,
          latencyMs: e.latencyMs,
          evaluatedAt: e.evaluatedAt.toISOString(),
          risk: r
            ? { score: r.score, tier: r.tier, scoreTier: explanation.scoreTier ?? r.tier, weightsVersion: r.weightsVersion, hardGates: r.hardGates, factors: r.factorsJson, explanation: explanation.explanation ?? [] }
            : null,
        };
      });
    });
  }),
});

