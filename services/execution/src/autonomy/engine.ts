import { and, eq, gte, sql } from 'drizzle-orm';
import { AutonomyStore, DemotionEngine, evaluate, featuresOf, score, stricter, type DemotionTrigger, type FeatureStats, type Tier } from '@vega/autonomy';
import { schema, withTenant } from '@vega/db';
import type { AutonomyContext, PolicyDecision, StepContext } from '@vega/orchestration';
import { PolicyEngine } from '../policy/engine.js';

/**
 * THE LADDER, ENFORCED — docs/module10.md §7. This is the only place a tier has any effect:
 * the UI shows a tier, the API changes one, but a call is only ever held back HERE, by the
 * executor, on every consequential step, reading the state fresh — so a demotion committed a
 * moment ago takes effect on the very next call of a run already in flight.
 *
 * The fold is always `stricter(policy, floor)`: autonomy can make a step MORE supervised than
 * policy alone would, never less (an AUTONOMOUS tier does not relax a REQUIRE_APPROVAL).
 *
 * Besides the tier itself, three runtime safeguards live here because they must be evaluated
 * per call, against the live state:
 *   · version change — the certification pinned a connector and model; if either moved, the
 *     pair demotes on the spot ("version_change"), and re-promotion needs a new certification
 *   · novelty — an input unlike the certified sample is routed to a person FOR THAT CALL; the
 *     tier is untouched (§6.1)
 *   · error rate / volume spike — rolling-window demotion triggers (§6)
 */
export interface AutonomyOptions {
  /** Rolling window and thresholds for the §6 rate triggers. */
  windowMs: number;
  errorRate: number;
  errorRateMinSamples: number;
  spikeFactor: number;
  spikeMinCalls: number;
  now?: () => Date;
}
export const DEFAULT_OPTIONS: AutonomyOptions = { windowMs: 14 * 86_400_000, errorRate: 0.2, errorRateMinSamples: 20, spikeFactor: 5, spikeMinCalls: 20 };

export interface AutonomyLog {
  warn(o: object, m: string): void;
}

/** Where an automatic demotion is also written: the evidence chain (`autonomy.changed`). */
export interface AutonomyAudit {
  append(e: { tenantId: string; kind: string; payload: Record<string, unknown> }): Promise<unknown>;
}

export class AutonomyEngine {
  readonly store: AutonomyStore;
  private readonly demotion: DemotionEngine;
  private readonly opts: AutonomyOptions;

  constructor(
    private readonly log: AutonomyLog,
    opts: Partial<AutonomyOptions> = {},
    store = new AutonomyStore(),
    private readonly audit?: AutonomyAudit,
  ) {
    this.store = store;
    this.demotion = new DemotionEngine(store);
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  /** The hook: the decision policy made, folded with what this pair's tier allows. */
  async fold(ctx: StepContext, decided: PolicyDecision, extra: AutonomyContext): Promise<PolicyDecision> {
    // A read changes nothing; the ladder governs consequential actions.
    if (ctx.tool.reversibility === 'R0') return decided;
    // An explicit deny (or an outage) is final; autonomy has nothing to add to it.
    if (decided.decision === 'DENY') return decided;
    // P5 `halt`: a tenant that chose to stop at its budget cap stops in-flight runs here too.
    const halt = await this.budgetHalt(ctx.tenantId);
    if (halt) {
      return { ...decided, decision: 'DENY', failClosed: false, reason: halt, chain: [...(decided.chain ?? []), { step: 'budget', detail: halt }] };
    }

    let state = await this.store.get(ctx.tenantId, ctx.agentId, ctx.toolId);
    if (!state) return decided; // untiered: "blocks nothing" until someone puts the pair on the ladder

    let tier = state.tier as Tier;
    const notes: string[] = [];

    // ---- version pinning: the certification no longer describes what is running ----
    if (state.certificationId && (tier === 'SAMPLED' || tier === 'AUTONOMOUS')) {
      const moved = await this.versionMoved(ctx, state.certificationId, extra.modelId);
      if (moved) {
        const r = await this.demotion.demote(ctx.tenantId, ctx.agentId, ctx.toolId, 'version_change', moved);
        if (r.demoted) {
          await this.record(ctx.tenantId, ctx.agentId, ctx.toolId, 'version_change', r, moved);
          tier = r.to;
          notes.push(`demoted to ${r.to}: ${moved['why'] as string}`);
        }
      }
    }
    // ---- rolling-window triggers ----
    if (tier === 'SAMPLED' || tier === 'AUTONOMOUS') {
      const trig = await this.rateTrigger(ctx);
      if (trig) {
        const r = await this.demotion.demote(ctx.tenantId, ctx.agentId, ctx.toolId, trig.trigger, trig.evidence);
        if (r.demoted) {
          await this.record(ctx.tenantId, ctx.agentId, ctx.toolId, trig.trigger, r, trig.evidence);
          tier = r.to;
          notes.push(`demoted to ${r.to}: ${trig.evidence['why'] as string}`);
        }
      }
      state = (await this.store.get(ctx.tenantId, ctx.agentId, ctx.toolId)) ?? state;
    }

    // ---- the tier's own floor ----
    const verdict = evaluate({ tier, sampleRate: state.sampleRate, sampleKey: `${ctx.runId}:${ctx.callSeq}` });
    let floor = verdict.floor;
    let why: string | null = floor ? `the ${tier} tier for ${ctx.toolId}${verdict.sampled ? ` sampled this action (1 in ${state.sampleRate ?? 5})` : ' requires a person to approve each action'}` : null;

    // ---- novelty: this one call is unlike what was certified → a person looks at it ----
    if (!floor && (tier === 'SAMPLED' || tier === 'AUTONOMOUS')) {
      const baseline = await this.store.latestBaseline(ctx.tenantId, ctx.agentId, ctx.toolId);
      if (baseline) {
        const feats = featuresOf({ recipients: PolicyEngine.recipientsOf(ctx), textLength: PolicyEngine.generatedContent(ctx).length, at: this.now() });
        const s = score(feats, baseline.featureStats as unknown as FeatureStats);
        if (s.novel) {
          floor = 'REQUIRE_APPROVAL';
          why = `this input is unlike what ${ctx.toolId} was certified on: ${s.reasons.join('; ')}`;
        }
      }
    }
    if (tier === 'SUSPENDED') why = `${ctx.toolId} is SUSPENDED for this workflow pending investigation; re-certify to restore it`;

    if (!floor) return notes.length ? { ...decided, chain: [...(decided.chain ?? []), { step: 'autonomy', detail: notes.join('; ') }] } : decided;
    const folded = stricter(decided.decision, floor);
    if (folded === decided.decision) return decided; // policy was already at least this strict
    return {
      ...decided,
      decision: folded,
      reason: `autonomy: ${why}${decided.reason ? ` — ${decided.reason}` : ''}`,
      approverRole: decided.approverRole ?? null,
      chain: [...(decided.chain ?? []), { step: 'autonomy', detail: [why, ...notes].filter(Boolean).join('; ') }],
    };
  }

  /** Event-driven demotion (§6): called from the executor at the moment a trigger fires. */
  async demote(tenantId: string, agentId: string, toolId: string, trigger: DemotionTrigger, evidence: Record<string, unknown>): Promise<void> {
    try {
      const r = await this.demotion.demote(tenantId, agentId, toolId, trigger, evidence);
      if (r.demoted) {
        this.log.warn({ tenant_id: tenantId, agent_id: agentId, tool_id: toolId, trigger, from: r.from, to: r.to }, 'autonomy: automatic demotion');
        await this.record(tenantId, agentId, toolId, trigger, r, evidence);
      }
    } catch (e) {
      // A failed demotion must never go unseen — but it must not take the run down either.
      this.log.warn({ err: e, tenant_id: tenantId, agent_id: agentId, tool_id: toolId, trigger }, 'autonomy: demotion could not be recorded');
    }
  }

  /** `autonomy.changed` in the chain. Best effort: the transition row is the system of record; a missed
   *  chain entry is logged loudly, never allowed to stop the demotion that already happened. */
  private async record(tenantId: string, agentId: string, toolId: string, trigger: DemotionTrigger, r: { from: Tier; to: Tier; transition?: { id: string } | undefined }, evidence: Record<string, unknown>): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.append({ tenantId, kind: 'autonomy.changed', payload: { workflow_key: agentId, action_type: toolId, from: r.from, to: r.to, direction: 'DEMOTE', trigger, automatic: true, transition_id: r.transition?.id ?? null, evidence } });
    } catch (e) {
      this.log.warn({ err: e, tenant_id: tenantId, agent_id: agentId, tool_id: toolId }, 'autonomy: demotion recorded in the database but NOT in the evidence chain');
    }
  }

  /** Non-null when this tenant's cap is reached AND they configured breach behavior "halt". */
  private async budgetHalt(tenantId: string): Promise<string | null> {
    return withTenant(tenantId, async (db) => {
      const [b] = await db.select().from(schema.budgets).where(eq(schema.budgets.tenantId, tenantId));
      if (!b || b.breachBehavior !== 'halt' || b.limitCents <= 0) return null;
      const [spend] = await db.select({ c: sql<string>`coalesce(sum(${schema.runs.costCents}), 0)` }).from(schema.runs).where(gte(schema.runs.startedAt, sql`date_trunc('month', now())`));
      const spent = Number(spend?.c ?? 0);
      return spent >= b.limitCents ? `the monthly budget (${(b.limitCents / 100).toFixed(2)}) is spent and the organization chose to halt at the cap` : null;
    });
  }

  private async versionMoved(ctx: StepContext, certificationId: string, modelId: string | null): Promise<Record<string, unknown> | null> {
    const cert = await withTenant(ctx.tenantId, async (db) => (await db.select().from(schema.certifications).where(eq(schema.certifications.id, certificationId)))[0]);
    if (!cert) return null;
    const pinned = (cert.connectorVersions as Record<string, number>)[ctx.toolId];
    if (pinned !== undefined && pinned !== ctx.tool.version) {
      return { why: `${ctx.toolId} changed from v${pinned} to v${ctx.tool.version} since it was certified`, certificationId, pinned, now: ctx.tool.version };
    }
    const models = (cert.modelVersions as string[]) ?? [];
    if (modelId && models.length && !models.includes(modelId)) {
      return { why: `planning model ${modelId} was not part of the certification (${models.join(', ')})`, certificationId, pinnedModels: models, now: modelId };
    }
    return null;
  }

  /** Error rate over the rolling window, and a volume spike against the trailing hourly rate. */
  private async rateTrigger(ctx: StepContext): Promise<{ trigger: DemotionTrigger; evidence: Record<string, unknown> } | null> {
    const since = new Date(this.now().getTime() - this.opts.windowMs);
    return withTenant(ctx.tenantId, async (db) => {
      const [d] = await db
        .select({ n: sql<number>`count(*)::int`, bad: sql<number>`count(*) FILTER (WHERE ${schema.approvalDecisions.decision} = 'reject' OR ${schema.approvalDecisions.edited})::int` })
        .from(schema.approvalDecisions)
        .innerJoin(schema.runs, eq(schema.runs.id, schema.approvalDecisions.runId))
        .where(and(eq(schema.approvalDecisions.toolId, ctx.toolId), eq(schema.runs.agentId, ctx.agentId), gte(schema.approvalDecisions.createdAt, since)));
      const [v] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.verifications)
        .where(and(eq(schema.verifications.agentId, ctx.agentId), eq(schema.verifications.toolId, ctx.toolId), gte(schema.verifications.createdAt, since), sql`${schema.verifications.outcome} IN ('ABORT','COMPENSATE')`));
      const total = (d?.n ?? 0) + (v?.n ?? 0);
      const bad = (d?.bad ?? 0) + (v?.n ?? 0);
      if (total >= this.opts.errorRateMinSamples && bad / total >= this.opts.errorRate) {
        return { trigger: 'error_rate' as const, evidence: { why: `${bad} of ${total} recent decisions were rejected, edited or stopped by verification (${((bad / total) * 100).toFixed(0)}%)`, bad, total, windowDays: this.opts.windowMs / 86_400_000 } };
      }
      // volume: calls in the last hour against the trailing mean per hour (excluding that hour)
      const hourAgo = new Date(this.now().getTime() - 3_600_000);
      const [c] = await db
        .select({ recent: sql<number>`count(*) FILTER (WHERE ${schema.actions.createdAt} >= ${hourAgo})::int`, older: sql<number>`count(*) FILTER (WHERE ${schema.actions.createdAt} < ${hourAgo})::int` })
        .from(schema.actions)
        .innerJoin(schema.runs, eq(schema.runs.id, schema.actions.runId))
        .where(and(eq(schema.actions.toolId, ctx.toolId), eq(schema.runs.agentId, ctx.agentId), gte(schema.actions.createdAt, since)));
      const hours = Math.max(1, this.opts.windowMs / 3_600_000 - 1);
      const mean = (c?.older ?? 0) / hours;
      if ((c?.recent ?? 0) >= this.opts.spikeMinCalls && (c?.recent ?? 0) > Math.max(mean, 1) * this.opts.spikeFactor) {
        return { trigger: 'volume_spike' as const, evidence: { why: `${c!.recent} calls in the last hour against a typical ${mean.toFixed(1)} per hour`, recent: c!.recent, hourlyMean: mean } };
      }
      return null;
    });
  }
}
