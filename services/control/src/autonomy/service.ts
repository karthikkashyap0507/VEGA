import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import {
  AutonomyStore,
  CertificationEngine,
  DemotionEngine,
  PromotionEngine,
  PromotionRefused,
  ProposalMiner,
  type CertificationReport,
  type CertificationRow,
  type ToolFacts,
  type Tier,
} from '@vega/autonomy';
import { ContactLedger, LockManager, WriteReconciler, normalizeIdentity, type Channel, type Relationship } from '@vega/contention';
import { schema, withTenant } from '@vega/db';
import { canonicalize, digestOf } from '@vega/verifier';
import { problems } from '@vega/shared';
import { ProblemError } from '../trpc.js';
import type { EvidenceClient } from '../evidence/client.js';

/**
 * THE CONTROL PLANE'S HALF OF MODULE 10 — docs/module10.md §4, §16.
 *
 * What lives here is everything a person does to the ladder and to contention: asking for a
 * certification, ratifying a promotion, demoting by hand, deciding a proposal, overriding a lock
 * or a cooldown, resolving a write conflict, reading analytics and setting a budget.
 *
 * What does NOT live here is enforcement. A tier changes what the executor does on the very
 * next call because the executor reads the state row; nothing in this file (and nothing in the
 * UI) holds a call back. That is also why a transition committed here needs no "push" to a run
 * already in flight.
 */

const DAY = 86_400_000;

export interface ServiceOptions {
  evidence?: EvidenceClient | undefined;
  now?: () => Date;
  log?: { warn(o: object, m: string): void } | undefined;
}

export interface OverviewRow {
  workflowKey: string;
  agentName: string | null;
  actionType: string;
  tier: Tier;
  sampleRate: number | null;
  daysAtTier: number;
  /** 30-day window. */
  decisions: number;
  actions: number;
  autonomousRate: number | null;
  edits: number;
  rejections: number;
  errors: number;
  /** The gate, as of the latest certification (or progress toward the sample size if none). */
  gate: Array<{ name: string; pass: boolean; detail: string }>;
  eligible: boolean;
  latestCertification: { id: string; recommendation: string; recommendedTier: string | null; createdAt: string; ratified: boolean } | null;
  openProposals: number;
}

export interface UsageRow {
  key: string;
  label: string | null;
  runs: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  costCents: number;
  governedActions: number;
  medianDurationMs: number | null;
}

export type UsageDimension = 'user' | 'agent' | 'workflow' | 'connector' | 'model';

export interface Anomaly {
  subjectKind: 'agent' | 'user';
  subjectId: string;
  metric: 'runs' | 'cost_cents';
  today: number;
  baselinePerDay: number;
  factor: number;
}

export class AutonomyService {
  readonly store: AutonomyStore;
  readonly locks: LockManager;
  readonly ledger: ContactLedger;
  readonly reconciler: WriteReconciler;
  private readonly certifier: CertificationEngine;
  private readonly promotion: PromotionEngine;
  private readonly demotion: DemotionEngine;
  private readonly miner: ProposalMiner;
  private readonly now: () => Date;

  constructor(private readonly opts: ServiceOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.store = new AutonomyStore();
    this.locks = new LockManager();
    this.ledger = new ContactLedger(this.now);
    this.reconciler = new WriteReconciler();
    this.certifier = new CertificationEngine(this.store);
    this.promotion = new PromotionEngine(this.store, this.now);
    this.demotion = new DemotionEngine(this.store);
    this.miner = new ProposalMiner(this.store, this.now);
  }

  // ------------------------------------------------------------------ the ladder

  /** Puts a pair on the ladder at SHADOW (idempotent). A pair with no row is untiered: it blocks nothing. */
  async enroll(tenantId: string, agentId: string, toolId: string): Promise<{ created: boolean }> {
    const rows = await withTenant(tenantId, (db) =>
      db.insert(schema.autonomyState).values({ tenantId, workflowKey: agentId, actionType: toolId, tier: 'SHADOW' }).onConflictDoNothing().returning({ id: schema.autonomyState.id }),
    );
    return { created: rows.length > 0 };
  }

  /** Dashboard rows (§15.1): per workflow × action, tier, autonomy rate, errors, days at tier, the gate. */
  async overview(tenantId: string, filter: { agentId?: string } = {}): Promise<OverviewRow[]> {
    const states = await this.store.list(tenantId, filter.agentId);
    if (!states.length) return [];
    const since = new Date(this.now().getTime() - 30 * DAY);
    const data = await withTenant(tenantId, async (db) => {
      const decisions = await db
        .select({
          agentId: schema.runs.agentId,
          toolId: schema.approvalDecisions.toolId,
          n: sql<number>`count(*)::int`,
          edits: sql<number>`count(*) FILTER (WHERE ${schema.approvalDecisions.edited})::int`,
          rejections: sql<number>`count(*) FILTER (WHERE ${schema.approvalDecisions.decision} = 'reject')::int`,
        })
        .from(schema.approvalDecisions)
        .innerJoin(schema.runs, eq(schema.runs.id, schema.approvalDecisions.runId))
        .where(gte(schema.approvalDecisions.createdAt, since))
        .groupBy(schema.runs.agentId, schema.approvalDecisions.toolId);
      const actions = await db
        .select({ agentId: schema.runs.agentId, toolId: schema.actions.toolId, n: sql<number>`count(*)::int` })
        .from(schema.actions)
        .innerJoin(schema.runs, eq(schema.runs.id, schema.actions.runId))
        .where(and(gte(schema.actions.createdAt, since), sql`${schema.actions.reversibility} <> 'R0'`))
        .groupBy(schema.runs.agentId, schema.actions.toolId);
      const verif = await db
        .select({ agentId: schema.verifications.agentId, toolId: schema.verifications.toolId, n: sql<number>`count(*)::int` })
        .from(schema.verifications)
        .where(and(gte(schema.verifications.createdAt, since), sql`${schema.verifications.outcome} IN ('ABORT','COMPENSATE')`))
        .groupBy(schema.verifications.agentId, schema.verifications.toolId);
      const certs = await db.select().from(schema.certifications).orderBy(desc(schema.certifications.createdAt));
      const proposals = await db.select({ subject: schema.policyProposals.subjectJson }).from(schema.policyProposals).where(eq(schema.policyProposals.state, 'open'));
      const agentIds = [...new Set(states.map((s) => s.workflowKey))];
      const names = await db.select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(inArray(schema.agents.id, agentIds));
      return { decisions, actions, verif, certs, proposals, names };
    });
    const k = (a: string, t: string) => `${a}|${t}`;
    const dec = new Map(data.decisions.map((d) => [k(d.agentId, d.toolId), d]));
    const act = new Map(data.actions.map((d) => [k(d.agentId, d.toolId), d.n]));
    const ver = new Map(data.verif.map((d) => [k(d.agentId ?? '', d.toolId ?? ''), d.n]));
    const name = new Map(data.names.map((n) => [n.id, n.name]));
    const latestCert = new Map<string, CertificationRow>();
    for (const c of data.certs) if (!latestCert.has(k(c.workflowKey, c.actionType))) latestCert.set(k(c.workflowKey, c.actionType), c);
    const openBy = new Map<string, number>();
    for (const p of data.proposals) {
      const s = p.subject as { workflowKey?: string; actionType?: string };
      if (s.workflowKey && s.actionType) openBy.set(k(s.workflowKey, s.actionType), (openBy.get(k(s.workflowKey, s.actionType)) ?? 0) + 1);
    }
    return states.map((s) => {
      const key = k(s.workflowKey, s.actionType);
      const d = dec.get(key);
      const n = act.get(key) ?? 0;
      const decisions = d?.n ?? 0;
      const cert = latestCert.get(key);
      const stillCurrent = cert && cert.fromTier === s.tier && !cert.decidedAt && cert.createdAt >= s.since;
      return {
        workflowKey: s.workflowKey,
        agentName: name.get(s.workflowKey) ?? null,
        actionType: s.actionType,
        tier: s.tier as Tier,
        sampleRate: s.sampleRate,
        daysAtTier: Math.max(0, Math.floor((this.now().getTime() - s.since.getTime()) / DAY)),
        decisions,
        actions: n,
        // Of the consequential actions in the window, the share that needed no person's decision.
        autonomousRate: n > 0 ? Math.max(0, (n - decisions) / n) : null,
        edits: d?.edits ?? 0,
        rejections: d?.rejections ?? 0,
        errors: (d?.edits ?? 0) + (d?.rejections ?? 0) + (ver.get(key) ?? 0),
        gate: (cert?.gateJson as OverviewRow['gate'] | undefined) ?? [],
        eligible: Boolean(stillCurrent && cert.recommendation === 'PROMOTE'),
        latestCertification: cert ? { id: cert.id, recommendation: cert.recommendation, recommendedTier: cert.recommendedTier, createdAt: cert.createdAt.toISOString(), ratified: Boolean(cert.decidedAt) } : null,
        openProposals: openBy.get(key) ?? 0,
      };
    });
  }

  async detail(tenantId: string, agentId: string, toolId: string) {
    const state = await this.store.get(tenantId, agentId, toolId);
    if (!state) return null;
    const [transitions, certs, proposals] = await Promise.all([
      this.store.transitions(tenantId, agentId, toolId),
      withTenant(tenantId, (db) => db.select().from(schema.certifications).where(and(eq(schema.certifications.workflowKey, agentId), eq(schema.certifications.actionType, toolId))).orderBy(desc(schema.certifications.createdAt)).limit(20)),
      this.store.proposals(tenantId, 'open'),
    ]);
    const baseline = await this.store.latestBaseline(tenantId, agentId, toolId);
    return {
      state,
      transitions,
      certifications: certs.map(certView),
      proposals: proposals.filter((p) => (p.subjectJson as { workflowKey?: string; actionType?: string }).workflowKey === agentId && (p.subjectJson as { actionType?: string }).actionType === toolId),
      novelty: baseline ? { computedAt: baseline.computedAt, samples: (baseline.featureStats as { contentLength?: { n?: number } | null }).contentLength?.n ?? null } : null,
    };
  }

  // ------------------------------------------------------------------ certification (§4)

  /**
   * Runs the certification and signs its report into the evidence chain BEFORE the row exists.
   * An unsigned report would be a claim, not evidence, so with no evidence plane this refuses.
   */
  async certify(i: { tenantId: string; actorId: string; agentId: string; tool: ToolFacts; windowDays: number }) {
    const evidence = this.opts.evidence;
    if (!evidence) throw new ProblemError(problems.upstreamUnavailable('evidence plane (a certification report must be signed into the chain)'));
    if (!(await this.store.get(i.tenantId, i.agentId, i.tool.toolId))) {
      throw new ProblemError(problems.preconditionFailed(`${i.tool.toolId} is not on the ladder for this agent yet: enroll it first (it starts at SHADOW)`));
    }
    const to = this.now();
    const from = new Date(to.getTime() - i.windowDays * DAY);
    let entryId = '';
    const out = await this.certifier.certify({
      tenantId: i.tenantId,
      workflowKey: i.agentId,
      actionType: i.tool.toolId,
      windowFrom: from,
      windowTo: to,
      tool: i.tool,
      sign: async (report) => {
        const bytes = Buffer.from(canonicalize(report), 'utf8');
        const r = await evidence
          .append({
          tenantId: i.tenantId,
          kind: 'certification.completed',
          payload: {
            workflow_key: report.workflowKey,
            action_type: report.actionType,
            window: report.window,
            from_tier: report.fromTier,
            sample_size: report.sampleSize,
            agreement_rate: report.agreementRate,
            edit_rate: report.editRate,
            critical_errors: report.criticalErrors,
            recommendation: report.recommendation,
            recommended_tier: report.recommendedTier,
            pinned: report.pinned,
            gate_passed: report.gate.every((g) => g.pass),
            report_digest: digestOf(bytes),
            requested_by: i.actorId,
          },
          content: [{ data: bytes.toString('base64'), mediaType: 'application/json', sensitivity: 'metadata' }],
          })
          .catch((e: unknown) => {
            throw e instanceof ProblemError ? e : new ProblemError(problems.upstreamUnavailable(`evidence plane (the report could not be signed: ${e instanceof Error ? e.message : String(e)})`));
          });
        entryId = r.id;
        return { reportRef: `evidence:${r.id}`, signature: r.entryHash };
      },
    });
    // The distribution of what was certified is what runtime novelty detection compares against.
    await this.store.saveNoveltyBaseline({ tenantId: i.tenantId, workflowKey: i.agentId, actionType: i.tool.toolId, featureStats: out.baseline as unknown as Record<string, unknown> });
    return { report: out.report, certification: certView(out.row), evidenceEntryId: entryId };
  }

  async certification(tenantId: string, id: string) {
    const row = await this.store.certification(tenantId, id);
    return row ? certView(row) : null;
  }

  /** The report as filed (§15.2): everything the viewer shows, recomputable from the stored fields. */
  async report(tenantId: string, id: string) {
    const row = await this.store.certification(tenantId, id);
    if (!row) return null;
    const gate = row.gateJson as CertificationReport['gate'];
    return {
      id: row.id,
      workflowKey: row.workflowKey,
      actionType: row.actionType,
      window: { from: row.windowFrom.toISOString(), to: row.windowTo.toISOString() },
      fromTier: row.fromTier,
      sampleSize: row.sampleSize,
      agreementRate: row.agreementRate,
      editRate: row.editRate,
      criticalErrors: row.criticalErrors,
      errorTaxonomy: row.errorTaxonomy,
      pinned: { connectorVersions: row.connectorVersions, modelVersions: row.modelVersions },
      gate,
      recommendation: row.recommendation,
      recommendedTier: row.recommendedTier,
      signed: { reportRef: row.reportRef, entryHash: row.signature, note: 'The report is an entry in the tenant’s evidence chain; verify it with the evidence pack verifier.' },
      ratification: row.decidedAt ? { by: row.decidedBy, at: row.decidedAt.toISOString() } : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  // ------------------------------------------------------------------ promotion / demotion

  /** The only way up. A named person, a certification that passes the gate again NOW. */
  async ratify(i: { tenantId: string; actorId: string; certificationId: string; tool: { version: number; simulateFidelity: string; autonomyCap?: 'SUPERVISED' | null }; sampleRate?: number | undefined }) {
    try {
      const r = await this.promotion.ratify({
        tenantId: i.tenantId,
        certificationId: i.certificationId,
        ratifiedBy: i.actorId,
        currentConnectorVersion: i.tool.version,
        currentSimulateFidelity: i.tool.simulateFidelity,
        autonomyCap: i.tool.autonomyCap ?? null,
        ...(i.sampleRate ? { sampleRate: i.sampleRate } : {}),
      });
      await this.record(i.tenantId, 'autonomy.changed', {
        workflow_key: r.transition.workflowKey,
        action_type: r.transition.actionType,
        from: r.transition.fromTier,
        to: r.transition.toTier,
        direction: 'PROMOTE',
        trigger: 'certification',
        automatic: false,
        ratified_by: i.actorId,
        certification_id: i.certificationId,
        report_ref: r.certification.reportRef,
        transition_id: r.transition.id,
      });
      return { transition: r.transition, certification: certView(r.certification) };
    } catch (e) {
      if (e instanceof PromotionRefused) throw new ProblemError(problems.preconditionFailed(e.message));
      throw e;
    }
  }

  async demote(i: { tenantId: string; actorId: string; agentId: string; toolId: string; to: Tier; reason: string }) {
    try {
      const t = await this.promotion.manualDemote({ tenantId: i.tenantId, workflowKey: i.agentId, actionType: i.toolId, to: i.to, by: i.actorId, reason: i.reason });
      await this.record(i.tenantId, 'autonomy.changed', { workflow_key: i.agentId, action_type: i.toolId, from: t.fromTier, to: t.toTier, direction: 'DEMOTE', trigger: 'manual', automatic: false, by: i.actorId, reason: i.reason, transition_id: t.id });
      return t;
    } catch (e) {
      if (e instanceof PromotionRefused) throw new ProblemError(problems.preconditionFailed(e.message));
      throw e;
    }
  }

  /**
   * §6, P2: an agent definition changed. What was certified is no longer what runs, so every
   * pair earned above SUPERVISED falls back — the certification no longer describes the agent.
   */
  async onAgentVersionChange(tenantId: string, agentId: string, version: number, by: string): Promise<number> {
    const states = await this.store.list(tenantId, agentId);
    let n = 0;
    for (const s of states) {
      if (s.tier !== 'SAMPLED' && s.tier !== 'AUTONOMOUS') continue;
      const r = await this.demotion.demote(tenantId, agentId, s.actionType, 'version_change', { why: `the agent definition changed (now v${version}); the certification described the previous one`, agentVersion: version, changedBy: by });
      if (!r.demoted) continue;
      n++;
      await this.record(tenantId, 'autonomy.changed', { workflow_key: agentId, action_type: s.actionType, from: r.from, to: r.to, direction: 'DEMOTE', trigger: 'version_change', automatic: true, agent_version: version, transition_id: r.transition?.id ?? null });
    }
    return n;
  }

  /** The chain entry for a human-driven change. The transition row is the system of record; a missed
   *  chain entry is logged, never allowed to undo a demotion that already took effect. */
  private async record(tenantId: string, kind: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.opts.evidence) {
      this.opts.log?.warn({ kind }, 'no evidence plane configured: this autonomy change has NO signed record');
      return;
    }
    try {
      await this.opts.evidence.append({ tenantId, kind, payload });
    } catch (e) {
      this.opts.log?.warn({ err: e, kind }, 'autonomy change recorded in the database but NOT in the evidence chain');
    }
  }

  // ------------------------------------------------------------------ proposals (§5)

  async generateProposals(tenantId: string) {
    await this.miner.expire(tenantId);
    return this.miner.generate(tenantId);
  }

  async proposals(tenantId: string, state: 'open' | 'accepted' | 'dismissed' | 'expired' = 'open') {
    return this.store.proposals(tenantId, state);
  }

  async decideProposal(tenantId: string, id: string, decision: 'accepted' | 'dismissed', by: string) {
    const p = await this.miner.decide(tenantId, id, decision, by);
    if (!p) throw new ProblemError(problems.preconditionFailed('this proposal is not open (it was decided or expired)'));
    // Accepting a proposal changes nothing by itself (§18): the change it describes is made as a
    // normal, audited action — authoring the policy, requesting the certification, demoting.
    return { proposal: p, next: p.state === 'accepted' ? p.proposedChange : null };
  }

  // ------------------------------------------------------------------ contention (§10)

  async activity(tenantId: string, entityKey: string) {
    return this.locks.activity(tenantId, entityKey);
  }

  async listLocks(tenantId: string) {
    return this.locks.list(tenantId);
  }

  async releaseLock(tenantId: string, lockId: string, by: string, reason: string) {
    const released = await this.locks.adminRelease(tenantId, lockId, by, reason);
    if (!released) throw new ProblemError(problems.notFound('no such lock (it may already be released)'));
    return { released };
  }

  async contactLedger(tenantId: string, identity?: string, limit = 100) {
    return this.ledger.history(tenantId, identity ? normalizeIdentity(identity) : undefined, limit);
  }

  /** An audited exception: the run named may contact this person despite a cooldown. */
  async contactOverride(i: { tenantId: string; actorId: string; identity: string; runId: string; reason: string; channel?: Channel; relationship?: Relationship | null }) {
    const [run] = await withTenant(i.tenantId, (db) => db.select({ agentId: schema.runs.agentId, principal: schema.runs.principalUserId }).from(schema.runs).where(eq(schema.runs.id, i.runId)));
    if (!run) throw new ProblemError(problems.notFound('run not found'));
    return this.ledger.override({ tenantId: i.tenantId, identity: i.identity, channel: i.channel ?? 'email', runId: i.runId, agentId: run.agentId, onBehalfOf: run.principal, relationship: i.relationship ?? null, by: i.actorId, reason: i.reason });
  }

  async writeConflicts(tenantId: string, which: 'open' | 'all' = 'all') {
    return which === 'open' ? this.reconciler.open(tenantId) : this.reconciler.list(tenantId);
  }

  async resolveConflict(tenantId: string, conflictId: string, by: string, chosenRunId: string) {
    const r = await this.reconciler.resolve(tenantId, conflictId, by, chosenRunId);
    if (!r) throw new ProblemError(problems.preconditionFailed('this conflict is not open, or the run named is not one of its proposals'));
    await withTenant(tenantId, (db) => db.insert(schema.platformEvents).values({ tenantId, actorId: by, kind: 'write_conflict.resolved', payload: { conflictId, chosenRunId } }));
    return r;
  }

  // ------------------------------------------------------------------ usage & budgets (P5)

  /**
   * Usage per user, agent, workflow (agent × action), connector, or planning model — `cost` as the
   * executor meters it. Success rate and latency are over terminal runs.
   */
  async usage(tenantId: string, q: { by: UsageDimension; from: Date; to: Date }): Promise<{ rows: UsageRow[]; totals: { runs: number; costCents: number; governedActions: number; costPerGovernedActionCents: number | null }; notes: string[] }> {
    const win = (col: unknown) => and(gte(col as never, q.from), lte(col as never, q.to));
    const rows = await withTenant(tenantId, async (db): Promise<UsageRow[]> => {
      if (q.by === 'connector') {
        const r = await db
          .select({
            key: sql<string>`${schema.toolInvocations.connectorId}::text`,
            label: schema.connectors.displayName,
            runs: sql<number>`count(*)::int`,
            ok: sql<number>`count(*) FILTER (WHERE ${schema.toolInvocations.state} = 'succeeded')::int`,
            bad: sql<number>`count(*) FILTER (WHERE ${schema.toolInvocations.state} = 'failed')::int`,
            p50: sql<number | null>`percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ${schema.toolInvocations.finishedAt} - ${schema.toolInvocations.startedAt}) * 1000)`,
          })
          .from(schema.toolInvocations)
          .leftJoin(schema.connectors, eq(schema.connectors.id, schema.toolInvocations.connectorId))
          .where(win(schema.toolInvocations.startedAt))
          .groupBy(schema.toolInvocations.connectorId, schema.connectors.displayName);
        return r.map((x) => ({ key: x.key, label: x.label, runs: x.runs, succeeded: x.ok, failed: x.bad, successRate: x.ok + x.bad > 0 ? x.ok / (x.ok + x.bad) : null, costCents: 0, governedActions: x.runs, medianDurationMs: x.p50 === null ? null : Math.round(Number(x.p50)) }));
      }
      if (q.by === 'model') {
        const r = await db
          .select({ key: schema.programs.modelId, runs: sql<number>`count(DISTINCT ${schema.programs.runId})::int`, plans: sql<number>`count(*)::int` })
          .from(schema.programs)
          .where(win(schema.programs.createdAt))
          .groupBy(schema.programs.modelId);
        return r.map((x) => ({ key: x.key, label: null, runs: x.runs, succeeded: 0, failed: 0, successRate: null, costCents: 0, governedActions: x.plans, medianDurationMs: null }));
      }
      const dim = q.by === 'user' ? schema.runs.principalUserId : schema.runs.agentId;
      const base = db
        .select({
          key: sql<string>`${dim}::text`,
          runs: sql<number>`count(*)::int`,
          ok: sql<number>`count(*) FILTER (WHERE ${schema.runs.status} = 'COMPLETED')::int`,
          bad: sql<number>`count(*) FILTER (WHERE ${schema.runs.status} IN ('FAILED','COMPENSATED','COMPENSATION_FAILED'))::int`,
          cost: sql<number>`coalesce(sum(${schema.runs.costCents}), 0)::int`,
          // the correlated reference is spelled out: drizzle would render a lone column unqualified inside the subquery
          actions: sql<number>`coalesce(sum((SELECT count(*) FROM actions a WHERE a.run_id = "runs"."id" AND a.reversibility <> 'R0')), 0)::int`,
          p50: sql<number | null>`percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ${schema.runs.endedAt} - ${schema.runs.startedAt}) * 1000) FILTER (WHERE ${schema.runs.endedAt} IS NOT NULL)`,
        })
        .from(schema.runs)
        .where(win(schema.runs.startedAt))
        .groupBy(dim);
      const r = await base;
      if (q.by === 'workflow') {
        // agent × action, run cost split across the actions the run took
        const w = await db.execute(sql`
          SELECT r.agent_id::text AS agent, a.tool_id AS tool, count(*)::int AS n,
                 coalesce(sum(r.cost_cents::numeric / nullif((SELECT count(*) FROM actions x WHERE x.run_id = r.id AND x.reversibility <> 'R0'), 0)), 0)::float AS cost,
                 count(DISTINCT r.id)::int AS runs
          FROM actions a JOIN runs r ON r.id = a.run_id
          WHERE a.reversibility <> 'R0' AND r.started_at BETWEEN ${q.from} AND ${q.to}
          GROUP BY r.agent_id, a.tool_id ORDER BY n DESC`);
        return (w.rows as Array<{ agent: string; tool: string; n: number; cost: number; runs: number }>).map((x) => ({ key: `${x.agent}:${x.tool}`, label: x.tool, runs: x.runs, succeeded: 0, failed: 0, successRate: null, costCents: Math.round(x.cost), governedActions: x.n, medianDurationMs: null }));
      }
      const labels = q.by === 'agent'
        ? new Map((await db.select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents)).map((a) => [a.id, a.name]))
        : new Map((await db.select({ id: schema.users.id, name: schema.users.displayName, email: schema.users.email }).from(schema.users)).map((u) => [u.id, u.name ?? u.email]));
      return r.map((x) => ({ key: x.key, label: labels.get(x.key) ?? null, runs: x.runs, succeeded: x.ok, failed: x.bad, successRate: x.ok + x.bad > 0 ? x.ok / (x.ok + x.bad) : null, costCents: x.cost, governedActions: x.actions, medianDurationMs: x.p50 === null ? null : Math.round(Number(x.p50)) }));
    });
    const totalRuns = rows.reduce((s, r) => s + r.runs, 0);
    const cost = rows.reduce((s, r) => s + r.costCents, 0);
    const governed = rows.reduce((s, r) => s + r.governedActions, 0);
    return {
      rows: rows.sort((a, b) => b.costCents - a.costCents || b.runs - a.runs),
      totals: { runs: totalRuns, costCents: cost, governedActions: governed, costPerGovernedActionCents: governed > 0 && q.by !== 'connector' && q.by !== 'model' ? cost / governed : null },
      notes: [
        'Cost is planning plus extraction as the executor meters it. Per-token counts and routing savings arrive with the model gateway’s metering (not billed on; shown because it is useful).',
        ...(q.by === 'workflow' ? ['Run cost is split evenly across the governed actions the run took.'] : []),
      ],
    };
  }

  /** Spend that is far above its own recent baseline, by agent and by user (§12 "anomalous-spend alerts"). */
  async anomalies(tenantId: string, opts: { factor?: number; minRuns?: number; minCostCents?: number } = {}): Promise<Anomaly[]> {
    const factor = opts.factor ?? 3;
    const minRuns = opts.minRuns ?? 10;
    const minCost = opts.minCostCents ?? 100;
    const now = this.now();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const since = new Date(dayStart.getTime() - 14 * DAY);
    const rows = await withTenant(tenantId, (db) =>
      db
        .select({ day: sql<string>`to_char(${schema.runs.startedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`, agent: schema.runs.agentId, user: schema.runs.principalUserId, n: sql<number>`count(*)::int`, cost: sql<number>`coalesce(sum(${schema.runs.costCents}),0)::int` })
        .from(schema.runs)
        .where(gte(schema.runs.startedAt, since))
        .groupBy(sql`1`, schema.runs.agentId, schema.runs.principalUserId),
    );
    const today = dayStart.toISOString().slice(0, 10);
    const out: Anomaly[] = [];
    for (const kind of ['agent', 'user'] as const) {
      const bySubject = new Map<string, { today: { runs: number; cost: number }; past: { runs: number; cost: number } }>();
      for (const r of rows) {
        const id = kind === 'agent' ? r.agent : r.user;
        const e = bySubject.get(id) ?? { today: { runs: 0, cost: 0 }, past: { runs: 0, cost: 0 } };
        const bucket = r.day === today ? e.today : e.past;
        bucket.runs += r.n;
        bucket.cost += r.cost;
        bySubject.set(id, e);
      }
      for (const [id, e] of bySubject) {
        // The baseline is the mean per day over the 14 days BEFORE today (quiet days count as zero).
        const runsBase = e.past.runs / 14;
        const costBase = e.past.cost / 14;
        if (e.today.runs >= minRuns && e.today.runs >= factor * Math.max(runsBase, 1)) out.push({ subjectKind: kind, subjectId: id, metric: 'runs', today: e.today.runs, baselinePerDay: runsBase, factor: e.today.runs / Math.max(runsBase, 1) });
        if (e.today.cost >= minCost && e.today.cost >= factor * Math.max(costBase, 1)) out.push({ subjectKind: kind, subjectId: id, metric: 'cost_cents', today: e.today.cost, baselinePerDay: costBase, factor: e.today.cost / Math.max(costBase, 1) });
      }
    }
    return out;
  }

  /** Records new anomalies as `usage.anomaly` events (once per subject, metric and day). */
  async scanAnomalies(tenantId: string): Promise<{ anomalies: Anomaly[]; raised: number }> {
    const found = await this.anomalies(tenantId);
    const day = this.now().toISOString().slice(0, 10);
    let raised = 0;
    await withTenant(tenantId, async (db) => {
      const existing = await db.select({ p: schema.platformEvents.payload }).from(schema.platformEvents).where(and(eq(schema.platformEvents.kind, 'usage.anomaly'), gte(schema.platformEvents.createdAt, new Date(this.now().getTime() - 2 * DAY))));
      const seen = new Set(existing.map((e) => `${(e.p as { day?: string }).day}|${(e.p as { subjectKind?: string }).subjectKind}|${(e.p as { subjectId?: string }).subjectId}|${(e.p as { metric?: string }).metric}`));
      for (const a of found) {
        if (seen.has(`${day}|${a.subjectKind}|${a.subjectId}|${a.metric}`)) continue;
        await db.insert(schema.platformEvents).values({ tenantId, actorId: null, kind: 'usage.anomaly', payload: { ...a, day } });
        raised++;
      }
    });
    return { anomalies: found, raised };
  }

  async budget(tenantId: string) {
    const now = this.now();
    return withTenant(tenantId, async (db) => {
      const [cap] = await db.select().from(schema.budgets).where(eq(schema.budgets.tenantId, tenantId));
      const [t] = await db.select({ plan: schema.tenants.plan, settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
      const [ent] = t ? await db.select({ limits: schema.planEntitlements.limits }).from(schema.planEntitlements).where(eq(schema.planEntitlements.plan, t.plan)) : [];
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const [spend] = await db.select({ c: sql<string>`coalesce(sum(${schema.runs.costCents}), 0)` }).from(schema.runs).where(gte(schema.runs.startedAt, monthStart));
      const settings = (t?.settings ?? {}) as { budgetCents?: number };
      const planLimit = (ent?.limits as { budgetCents?: number } | undefined)?.budgetCents ?? 0;
      // The same precedence the planner route applies: the tenant's own cap, then settings, then the plan's.
      const limit = cap && cap.limitCents > 0 ? cap.limitCents : (settings.budgetCents ?? planLimit);
      const spent = Number(spend?.c ?? 0);
      const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
      const elapsed = Math.max(1, now.getUTCDate() - 1 + (now.getUTCHours() + 1) / 24);
      const behavior = (cap?.breachBehavior ?? 'queue') as 'degrade' | 'queue' | 'halt';
      return {
        limitCents: limit,
        configuredLimitCents: cap?.limitCents ?? 0,
        breachBehavior: behavior,
        spentCents: spent,
        remainingCents: limit > 0 ? Math.max(0, limit - spent) : null,
        percentUsed: limit > 0 ? spent / limit : null,
        projectedCents: Math.round((spent / elapsed) * daysInMonth),
        state: limit <= 0 ? ('uncapped' as const) : spent >= limit ? ('exceeded' as const) : spent >= limit * 0.8 ? ('warning' as const) : ('ok' as const),
        periodStart: monthStart.toISOString(),
        updatedAt: cap?.updatedAt.toISOString() ?? null,
        updatedBy: cap?.updatedBy ?? null,
      };
    });
  }

  async setBudget(tenantId: string, by: string, input: { limitCents: number; breachBehavior: 'degrade' | 'queue' | 'halt' }) {
    await withTenant(tenantId, async (db) => {
      await db
        .insert(schema.budgets)
        .values({ tenantId, limitCents: input.limitCents, breachBehavior: input.breachBehavior, updatedBy: by })
        .onConflictDoUpdate({ target: schema.budgets.tenantId, set: { limitCents: input.limitCents, breachBehavior: input.breachBehavior, updatedBy: by, updatedAt: new Date() } });
      await db.insert(schema.platformEvents).values({ tenantId, actorId: by, kind: 'budget.updated', payload: input });
    });
    return this.budget(tenantId);
  }
}

/** The certification as the API shows it: numbers as numbers, dates as ISO, the chain entry named. */
export function certView(c: CertificationRow) {
  return {
    id: c.id,
    workflowKey: c.workflowKey,
    actionType: c.actionType,
    window: { from: c.windowFrom.toISOString(), to: c.windowTo.toISOString() },
    sampleSize: c.sampleSize,
    agreementRate: c.agreementRate,
    editRate: c.editRate,
    criticalErrors: c.criticalErrors,
    errorTaxonomy: c.errorTaxonomy,
    connectorVersions: c.connectorVersions,
    modelVersions: c.modelVersions,
    fromTier: c.fromTier,
    recommendation: c.recommendation,
    recommendedTier: c.recommendedTier,
    gate: c.gateJson,
    reportRef: c.reportRef,
    ratifiedBy: c.decidedBy,
    ratifiedAt: c.decidedAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}
