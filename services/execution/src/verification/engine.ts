import { and, eq, gte, ne, sql } from 'drizzle-orm';
import { argsDigest } from '@vega/connector-sdk';
import type { Effect } from '@vega/contracts';
import { schema, withTenant } from '@vega/db';
import type { StepContext, VerificationInput, VerificationOutcome, VerifyResult } from '@vega/orchestration';
import { PatternClassifier, type Classification } from '@vega/policy-engine';
import { evidenceFrom, generatedContent, groundedness, verify, type Check, type CheckName, type ClaimExtractor, type Evidence, type GroundednessReport, type Phase, type Verdict } from '@vega/verification';

/**
 * C6 — THE VERIFICATION ENGINE, execution plane (docs/module9.md §5; PROJECT.md D-18).
 *
 * It runs where the action runs: between simulation and approval (pre-commit) and after the call
 * (post-commit), inside the same durable step, on the arguments actually about to be sent — not
 * on what the plan said they would be. The checks, cheapest first:
 *
 *   permissions   the principal, the agent and the connector are still allowed, NOW
 *   policy        the decision after generation against the plan-time expectation (M5)
 *   conflicts     the same outreach already sent in the last 24h; a record this run already set
 *                 to something else
 *   exposure      what the content contains (M5 classification) against who receives it
 *   consequence   the simulated effect against what the plan said (internal stays internal);
 *                 post-commit: who was actually reached against who was approved
 *   groundedness  every number, price, date and promise found in what the run read
 *
 * Every verification is a row (`verifications`, append-only) with its findings; the run carries a
 * running summary for M10.
 */

export interface KnowledgeLookup {
  search(tenantId: string, q: { userId: string; query: string; k?: number; runId?: string | null; purpose?: 'groundedness'; taints?: Array<'TRUSTED' | 'ORG' | 'UNTRUSTED'> }): Promise<{ hits: Array<{ chunkId: string; documentId: string; content: string; taint: 'TRUSTED' | 'ORG' | 'UNTRUSTED' }> }>;
}

export interface VerificationDeps {
  /** M5's cached classifier (PolicyEngine.classify). Absent: the pattern classifier, in process. */
  classify?: ((tenantId: string, text: string) => Promise<Classification | null>) | undefined;
  /** The knowledge base, for evidence beyond what the run read. */
  kb?: KnowledgeLookup | undefined;
  extractor?: ClaimExtractor | undefined;
  log: { warn(o: object, m: string): void; error(o: object, m: string): void };
  now?: () => Date;
}

const DAY = 86_400_000;
const SENSITIVE = 70;
const NEEDS_APPROVAL = new Set(['REQUIRE_APPROVAL', 'REQUIRE_DUAL_APPROVAL']);
const PERMISSIVE = new Set(['PROCEED', 'ALLOW']);
const domainOf = (a: string) => a.split('@')[1]?.toLowerCase() ?? '';

export class VerificationEngine {
  private readonly patterns = new PatternClassifier();

  constructor(private readonly deps: VerificationDeps) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  // ------------------------------------------------------------------ the hooks
  async preVerify(ctx: StepContext, input: VerificationInput): Promise<VerificationOutcome> {
    let report: GroundednessReport | null = null;
    const effect = input.sim.ok ? input.sim.effect : null;
    const checks: Partial<Record<CheckName, Check>> = {
      permissions: () => this.permissions(ctx),
      policy: () => this.policy(ctx, input),
      ...(ctx.tool.reversibility !== 'R0'
        ? {
            conflicts: () => this.conflicts(ctx, effect, input.approved),
            exposure: () => this.exposure(ctx, effect, input.approved),
            consequence: () => this.consequence(ctx, input),
            groundedness: async () => {
              const g = await this.groundedness(ctx, input);
              report = g.report;
              return g.result;
            },
          }
        : {}),
    };
    const v = await verify('pre_commit', checks);
    // A person approved this call with these findings in front of them: what would escalate is
    // now a warning on the record, not a second request.
    const settled = input.approved && v.outcome === 'ESCALATE' ? { ...v, outcome: 'WARN' as const, results: v.results.map((r) => (r.outcome === 'ESCALATE' ? { ...r, outcome: 'WARN' as const, detail: `${r.detail} — approved by a person` } : r)) } : v;
    return this.persist(ctx, settled, report, input.policy.riskTier ?? null);
  }

  async verify(ctx: StepContext, result: { effect: Effect<unknown>; input?: VerificationInput }): Promise<VerifyResult> {
    if (ctx.tool.reversibility === 'R0') return { ok: true };
    const v = await verify('post_commit', { consequence: () => this.reached(ctx, result.effect, result.input) });
    const out = await this.persist(ctx, v, null, result.input?.policy.riskTier ?? null);
    if (v.outcome === 'COMPENSATE') return { ok: false, reason: v.reason ?? 'post-commit verification failed', compensate: true, verification: out };
    return { ok: true, verification: out };
  }

  // ------------------------------------------------------------------ 1 permissions
  private async permissions(ctx: StepContext): Promise<ReturnType<typeof row>> {
    const facts = await withTenant(ctx.tenantId, async (db) => {
      const [user] = await db.select({ status: schema.users.status }).from(schema.users).where(eq(schema.users.id, ctx.principalUserId));
      const [agent] = await db.select({ status: schema.agents.status }).from(schema.agents).where(eq(schema.agents.id, ctx.agentId));
      const [conn] = ctx.connectorId ? await db.select({ status: schema.connectors.status, scopes: schema.connectors.scopesGranted, kind: schema.connectors.kind }).from(schema.connectors).where(eq(schema.connectors.id, ctx.connectorId)) : [];
      return { user, agent, conn };
    });
    if (!facts.user || facts.user.status !== 'active') return row('ABORT', `the person this run acts for is ${facts.user?.status ?? 'gone'}`);
    if (facts.agent && (facts.agent.status === 'suspended' || facts.agent.status === 'archived')) return row('ABORT', `the agent is ${facts.agent.status}`);
    if (facts.conn) {
      if (facts.conn.status === 'revoked') return row('ABORT', `the ${facts.conn.kind} connection was revoked`);
      // Expired is not a refusal: the call returns AUTH_EXPIRED and the run pauses for
      // re-authorization (M2), resuming where it stopped.
      if (facts.conn.status === 'expired') return row('WARN', `the ${facts.conn.kind} connection has expired; the run will pause for re-authorization`);
      const missing = facts.conn.scopes.length ? ctx.tool.scopes.filter((s) => !facts.conn!.scopes.includes(s)) : [];
      if (missing.length) return row('ABORT', `the ${facts.conn.kind} connection no longer grants ${missing.join(', ')}`);
    }
    return row('PASS', 'current at execution time');
  }

  // ------------------------------------------------------------------ 2 policy, after generation
  private async policy(ctx: StepContext, input: VerificationInput): Promise<ReturnType<typeof row>> {
    const planned = await this.planned(ctx);
    const now = input.policy.decision;
    const tier = input.policy.riskTier ?? 'unscored';
    if (planned?.decision && PERMISSIVE.has(planned.decision) && NEEDS_APPROVAL.has(now)) {
      const detail = `re-evaluated after generation — the plan expected no approval; the content now needs one (${tier}): ${input.policy.reason ?? ''}`.trim();
      return row(input.approved ? 'WARN' : 'ESCALATE', detail, { planned: planned.decision, now, tier });
    }
    return row('PASS', `re-evaluated after generation — ${now === input.engineDecision ? '' : 'gate folded in, '}tier ${tier}`, { planned: planned?.decision ?? null, now, tier });
  }

  /** What the plan said about this call (C2's plan-time check on task_nodes). */
  private async planned(ctx: StepContext): Promise<{ decision: string | null; egress: string | null } | null> {
    return withTenant(ctx.tenantId, async (db) => {
      const [byId] = await db.select({ decision: schema.taskNodes.plannedDecision, egress: schema.taskNodes.plannedEgress }).from(schema.taskNodes).where(eq(schema.taskNodes.id, ctx.nodeRowId));
      if (byId?.decision || byId?.egress) return byId;
      const [byNode] = await db
        .select({ decision: schema.taskNodes.plannedDecision, egress: schema.taskNodes.plannedEgress })
        .from(schema.taskNodes)
        .where(and(eq(schema.taskNodes.runId, ctx.runId), eq(schema.taskNodes.dslNodeId, ctx.nodeId), sql`(${schema.taskNodes.plannedDecision} IS NOT NULL OR ${schema.taskNodes.plannedEgress} IS NOT NULL)`))
        .limit(1);
      return byNode ?? null;
    });
  }

  // ------------------------------------------------------------------ 3 conflicts
  private async conflicts(ctx: StepContext, effect: Effect<unknown> | null, approved: boolean): Promise<ReturnType<typeof row>> {
    const d = argsDigest(ctx.args);
    const since = new Date(this.now().getTime() - DAY);
    const { dup, mine } = await withTenant(ctx.tenantId, async (db) => {
      // The same message to the same people, already sent (by any run) in the last day.
      const [dup] = effect?.externalRecipients.length
        ? await db
            .select({ runId: schema.actions.runId, at: schema.actions.committedAt })
            .from(schema.actions)
            .where(and(eq(schema.actions.toolId, ctx.toolId), eq(schema.actions.argsDigest, d), eq(schema.actions.state, 'COMMITTED'), gte(schema.actions.createdAt, since), ne(schema.actions.nodeId, ctx.nodeRowId)))
            .limit(1)
        : [];
      // What this run already wrote, for contradictory updates.
      const mine = effect?.recordsAffected.some((r) => r.field !== undefined)
        ? await db.select({ effect: schema.actions.effectJson, toolId: schema.actions.toolId }).from(schema.actions).where(and(eq(schema.actions.runId, ctx.runId), eq(schema.actions.state, 'COMMITTED'), ne(schema.actions.nodeId, ctx.nodeRowId)))
        : [];
      return { dup, mine };
    });
    if (dup) {
      const ago = dup.at ? `${Math.max(1, Math.round((this.now().getTime() - dup.at.getTime()) / 60_000))} min ago` : 'recently';
      const what = `the same ${ctx.toolId} to ${effect!.externalRecipients.join(', ')} was already sent ${ago}`;
      // Within one run it is a loop: stop. From another run a person may mean it (a re-send): ask.
      if (dup.runId === ctx.runId) return row('ABORT', `${what} by this run`, { duplicateOf: dup.runId });
      return row(approved ? 'WARN' : 'ESCALATE', `${what} (run ${dup.runId})`, { duplicateOf: dup.runId });
    }
    for (const r of effect?.recordsAffected ?? []) {
      if (r.field === undefined) continue;
      for (const m of mine) {
        const prior = ((m.effect as { recordsAffected?: Array<{ system: string; id: string; field?: string; after?: unknown }> } | null)?.recordsAffected ?? []).find((p) => p.system === r.system && p.id === r.id && p.field === r.field);
        if (prior && JSON.stringify(prior.after) !== JSON.stringify(r.after)) {
          return row('ESCALATE', `this run already set ${r.system} ${r.id} ${r.field} to ${JSON.stringify(prior.after)}; now ${JSON.stringify(r.after)}`, { record: r });
        }
      }
    }
    return row('PASS', 'no duplicate outreach or contradictory update');
  }

  // ------------------------------------------------------------------ 4 data exposure
  private async exposure(ctx: StepContext, effect: Effect<unknown> | null, approved: boolean): Promise<ReturnType<typeof row>> {
    const external = effect?.externalRecipients ?? [];
    const text = generatedContent(ctx.args, ctx.tool.recipientArgs).map((c) => c.text).join('\n');
    if (!text.trim()) return row('PASS', 'no generated content');
    const c = (await this.deps.classify?.(ctx.tenantId, text)) ?? (await this.patterns.classify(text));
    const ids = c.entities.filter((e) => e.type !== 'EMAIL_ADDRESS').length;
    if (!external.length) return row('PASS', c.sensitivity >= SENSITIVE ? `sensitive content (${c.labels.join(', ')}) stays inside the organization` : 'internal only', { sensitivity: c.sensitivity });
    if (c.labels.includes('SECRET')) return row('ABORT', `a credential would leave the organization (to ${external.join(', ')})`, { labels: c.labels });
    if (c.sensitivity < SENSITIVE) return row('PASS', ids ? `${ids} identifier${ids === 1 ? '' : 's'}, below the sensitivity threshold` : 'nothing sensitive', { sensitivity: c.sensitivity });
    const trusted = await withTenant(ctx.tenantId, (db) => db.select({ email: schema.trustedContacts.email }).from(schema.trustedContacts));
    const known = new Set(trusted.map((t) => t.email.toLowerCase()));
    const unknown = external.filter((r) => !known.has(r.toLowerCase()));
    const what = `${c.labels.join(', ') || 'sensitive'} content (sensitivity ${c.sensitivity})`;
    if (!unknown.length) return row('WARN', `${what}, expected for this recipient (a trusted contact)`, { sensitivity: c.sensitivity, labels: c.labels });
    return row(approved ? 'WARN' : 'ESCALATE', `${what} to ${unknown.length === 1 ? 'a recipient' : 'recipients'} not on the trusted list (${[...new Set(unknown.map(domainOf))].join(', ')})`, { sensitivity: c.sensitivity, labels: c.labels, unknown });
  }

  // ------------------------------------------------------------------ 5 consequence
  private async consequence(ctx: StepContext, input: VerificationInput): Promise<ReturnType<typeof row>> {
    if (!input.sim.ok) return row('WARN', `the effect could not be simulated (${input.sim.reason}); it was not checked against the plan`);
    const planned = await this.planned(ctx);
    const external = input.sim.effect.externalRecipients;
    if (planned?.egress === 'INTERNAL' && external.length) return row('ABORT', `the plan said this stays inside the organization; it would reach ${external.join(', ')}`, { planned: 'INTERNAL', external });
    return row('PASS', 'simulated effect matches the plan', { fidelity: input.sim.effect.fidelity });
  }

  /** Post-commit: who was actually reached, against who the simulation (and the approver) saw. */
  private async reached(ctx: StepContext, effect: Effect<unknown>, input?: VerificationInput): Promise<ReturnType<typeof row>> {
    const expected = new Set((input?.sim.ok ? input.sim.effect.externalRecipients : []).map((r) => r.toLowerCase()));
    if (!input?.sim.ok) return row('PASS', 'no simulated effect to compare against');
    const extra = effect.externalRecipients.filter((r) => !expected.has(r.toLowerCase()));
    if (extra.length) return row('ABORT', `the action reached ${extra.join(', ')}, who ${input.approved ? 'the approver' : 'the simulation'} never saw`, { extra });
    return row('PASS', `reached exactly who was ${input.approved ? 'approved' : 'simulated'}`);
  }

  // ------------------------------------------------------------------ 6 groundedness
  private async groundedness(ctx: StepContext, input: VerificationInput): Promise<{ result: ReturnType<typeof row>; report: GroundednessReport | null }> {
    const content = generatedContent(ctx.args, ctx.tool.recipientArgs);
    if (!content.length) return { result: row('PASS', 'no generated content'), report: null };
    const evidence: Evidence[] = [{ id: `objective:${ctx.runId}`, text: input.objective, taint: 'TRUSTED' }, ...input.reads.map((r) => evidenceFrom(r.id, r.value, r.taint))];
    const tier = input.policy.riskTier ?? null;
    if (this.deps.kb && tier && tier !== 'LOW') {
      try {
        const { hits } = await this.deps.kb.search(ctx.tenantId, { userId: ctx.principalUserId, query: content.map((c) => c.text).join('\n').slice(0, 1000), k: 5, runId: ctx.runId, purpose: 'groundedness', taints: ['TRUSTED', 'ORG'] });
        evidence.push(...hits.map((h) => ({ id: `kb:${h.documentId}:${h.chunkId}`, text: h.content, taint: h.taint })));
      } catch (e) {
        this.deps.log.warn({ err: e, run_id: ctx.runId }, 'knowledge base unavailable for groundedness; checking against what the run read only');
      }
    }
    const report = await groundedness(content, evidence, tier, this.deps.extractor);
    const flagged = report.unsupported + report.contradicted;
    const summary = `${flagged} of ${report.claims} claim${report.claims === 1 ? '' : 's'} unsupported${report.contradicted ? ` (${report.contradicted} contradicted)` : ''}`;
    const block = report.findings.filter((f) => f.severity === 'BLOCK');
    if (block.some((f) => f.verdict === 'CONTRADICTED')) return { result: row('ABORT', `${summary}: the sources say otherwise`, { ...counts(report) }), report };
    if (block.length) return { result: row('ESCALATE', summary, counts(report)), report };
    if (report.findings.some((f) => f.severity === 'WARN')) return { result: row('WARN', summary, counts(report)), report };
    return { result: row('PASS', report.claims ? `all ${report.claims} claims supported` : 'no factual claims'), report };
  }

  // ------------------------------------------------------------------ the record
  private async persist(ctx: StepContext, v: Verdict, report: GroundednessReport | null, tier: string | null): Promise<VerificationOutcome> {
    const failed = v.results.find((r) => r.outcome === 'ABORT' || r.outcome === 'COMPENSATE' || r.outcome === 'ESCALATE');
    const flagged = (report?.findings ?? []).filter((f) => f.verdict !== 'SUPPORTED' || f.untrustedOnly);
    const unsupportedClaims = flagged.map((f) => ({ text: f.claim.text, reason: f.verdict === 'CONTRADICTED' ? `contradicted by a source${f.note ? ` — ${f.note}` : ''}` : f.untrustedOnly ? 'found only in untrusted content' : `no trusted source supports this ${f.claim.kind}` }));
    let id: string | null = null;
    try {
      id = await withTenant(ctx.tenantId, async (db) => {
        const [r] = await db
          .insert(schema.verifications)
          .values({ tenantId: ctx.tenantId, runId: ctx.runId, nodeId: ctx.nodeRowId, agentId: ctx.agentId, toolId: ctx.toolId, phase: v.phase, checksJson: v.results, outcome: v.outcome, failedCheck: failed?.check ?? null, riskTier: tier, durationMs: v.durationMs })
          .returning({ id: schema.verifications.id });
        if (report?.findings.length) {
          await db.insert(schema.groundednessFindings).values(
            report.findings.map((f) => ({ tenantId: ctx.tenantId, verificationId: r!.id, claimText: f.claim.text.slice(0, 2000), claimKind: f.claim.kind, field: f.claim.field, verdict: f.verdict, supported: f.verdict === 'SUPPORTED', sourceIds: f.sourceIds, confidence: f.untrustedOnly ? 0.5 : 0.9, severity: f.severity })),
          );
        }
        // The run's running summary (M10 reads months of these without joining every row).
        const key = v.outcome.toLowerCase();
        await db.execute(sql`UPDATE runs SET verification_summary = jsonb_build_object(
            'verifications', coalesce((verification_summary->>'verifications')::int, 0) + 1,
            ${key}::text, coalesce((verification_summary->>${key})::int, 0) + 1,
            'unsupportedClaims', coalesce((verification_summary->>'unsupportedClaims')::int, 0) + ${unsupportedClaims.length}::int,
            'last', ${JSON.stringify({ phase: v.phase, outcome: v.outcome, toolId: ctx.toolId, failedCheck: failed?.check ?? null })}::jsonb
          ) || (coalesce(verification_summary, '{}'::jsonb) - 'verifications' - ${key}::text - 'unsupportedClaims' - 'last')
          WHERE id = ${ctx.runId}`);
        return r!.id;
      });
    } catch (e) {
      // The verdict stands even if its record could not be written; the receipt still carries it.
      this.deps.log.error({ err: e, run_id: ctx.runId }, 'could not record the verification');
    }
    return { id, phase: v.phase, outcome: v.outcome, reason: v.reason, checks: v.results.map((r) => ({ check: r.check, outcome: r.outcome, detail: r.detail })), unsupportedClaims };
  }
}

function row(outcome: 'PASS' | 'WARN' | 'ESCALATE' | 'ABORT', detail: string, data?: Record<string, unknown>) {
  return { outcome, detail, ...(data ? { data } : {}) };
}

const counts = (r: GroundednessReport) => ({ claims: r.claims, unsupported: r.unsupported, contradicted: r.contradicted, blocking: r.blocking });

export type { Phase };
