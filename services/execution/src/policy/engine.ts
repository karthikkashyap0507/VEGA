import { performance } from 'node:perf_hooks';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { schema, withTenant } from '@vega/db';
import { underRecipient } from '@vega/dsl';
import type { PolicyDecision, ReasonStep, StepContext } from '@vega/orchestration';
import {
  combine,
  digestOf,
  failClosed,
  PRESET_MODES,
  PRESETS_BUNDLE,
  packageFor,
  tenantBundleName,
  tenantPackage,
  versionOfRevision,
  type Classification,
  type Classifier,
  type CombinedDecision,
  type Match,
  type OpaClient,
  type PolicyInput,
  type PresetMode,
} from '@vega/policy-engine';
import { DEFAULT_WEIGHTS, scoreRisk, type Role, type RiskInput, type RiskResult, type Taint, type Weights } from '@vega/risk';

/**
 * THE POLICY HOOK — docs/module5.md §8.1, the execution plane's half of Module 5.
 *
 *   classify generated content (cached by digest) → scoreRisk (the tenant's weights)
 *     → OPA: the preset package + the tenant's package (signed bundles)
 *     → combine (most restrictive wins; hard gates override the score)
 *     → persist policy_evaluations + risk_evaluations → the decision and its reason chain
 *
 * It runs INSIDE the executor's durable step for the call, so a replayed run gets the recorded
 * decision, not a new one. It is synchronous and on the critical path (budget: p99 < 50 ms);
 * tenant facts are cached for a few seconds, Presidio is consulted only on a cache miss, and
 * the two OPA queries run in parallel.
 *
 * THE FACTS, and three choices the spec leaves open (docs/module5-implementation.md §3):
 *   · sensitivity — the declaration's `sensitivityHint` is the PRIOR when nothing was
 *     classified (reads, content-less calls). Classified generated content replaces it, but
 *     never drops below half the prior: a share-by-reference tool (gdrive.share) exposes
 *     content its arguments do not carry.
 *   · blast radius — a messaging tool (one with recipient arguments) affects its recipients,
 *     not "records"; any other write affects one record unless it says otherwise.
 *   · exposure — for the RISK factor, a send whose every recipient is in the organization's
 *     own domains is INTERNAL exposure. The policy input keeps the declared egress class, so a
 *     policy about "external channels" still sees it.
 *
 * FAIL CLOSED. Anything that stops the engine from deciding — OPA unreachable, a bundle that
 * should be loaded and is not, Presidio down, the database refusing the record — is a DENY,
 * recorded where possible, logged as an alert and published as `policy.unavailable`. There is
 * no path on which "could not decide" becomes "allowed".
 */

export interface PolicyEngineLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface Alerter {
  alert(a: { kind: string; tenantId: string; runId: string; toolId: string; message: string }): Promise<void>;
}

export interface PolicyEngineOptions {
  opa: OpaClient;
  classifier: Classifier;
  /** Recorded with each cached classification (`presidio`, `pattern-dev`). */
  classifierName: string;
  log: PolicyEngineLog;
  alerter?: Alerter | undefined;
  /** Tenant facts (preset, weights, active bundle, budget) are re-read after this long. */
  cacheTtlMs?: number;
  now?: () => number;
}

interface TenantFacts {
  preset: PresetMode;
  activeBundleVersion: number | null;
  weights: Weights;
  orgDomains: Set<string>;
  budget: { monthCents: number; limitCents: number };
  at: number;
}

const ROLES: ReadonlySet<string> = new Set(['OWNER', 'ADMIN', 'COMPLIANCE_OFFICER', 'WORKFLOW_OWNER', 'APPROVER', 'MEMBER', 'AUDITOR']);
const TAINT_ORDER: Record<Taint, number> = { TRUSTED: 0, ORG: 1, UNTRUSTED: 2 };
/** Generated content beyond this is truncated for classification (Presidio latency is linear). */
const MAX_CLASSIFY_CHARS = 100_000;

export class PolicyUnavailable extends Error {}

export class PolicyEngine {
  private readonly facts = new Map<string, TenantFacts>();
  private readonly roles = new Map<string, { role: Role; at: number }>();

  constructor(private readonly opts: PolicyEngineOptions) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  /** Forget cached tenant facts (tests; an activation seen by this process). */
  invalidate(tenantId?: string) {
    if (tenantId) this.facts.delete(tenantId);
    else this.facts.clear();
  }

  // ------------------------------------------------------------------ tenant facts
  private async tenantFacts(tenantId: string): Promise<TenantFacts> {
    const hit = this.facts.get(tenantId);
    if (hit && this.now() - hit.at < (this.opts.cacheTtlMs ?? 5_000)) return hit;
    const facts = await withTenant(tenantId, async (db) => {
      const [t] = await db.select({ settings: schema.tenants.settings, plan: schema.tenants.plan }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
      const settings = (t?.settings ?? {}) as { policyPreset?: string; budgetCents?: number; orgDomains?: string[] };
      const [active] = await db
        .select({ version: schema.policyBundles.version })
        .from(schema.policyBundles)
        .where(and(isNotNull(schema.policyBundles.activatedAt), isNull(schema.policyBundles.supersededAt)));
      const [w] = await db
        .select()
        .from(schema.riskWeights)
        .where(lte(schema.riskWeights.activeFrom, new Date(this.now())))
        .orderBy(sql`${schema.riskWeights.tenantId} IS NULL`, desc(schema.riskWeights.activeFrom), desc(schema.riskWeights.version))
        .limit(1);
      const domains = await db
        .selectDistinct({ d: sql<string>`lower(split_part(${schema.users.email}, '@', 2))` })
        .from(schema.users)
        .where(sql`${schema.users.email} LIKE '%@%'`);
      const [spend] = await db
        .select({ c: sql<string>`coalesce(sum(${schema.runs.costCents}), 0)` })
        .from(schema.runs)
        .where(gte(schema.runs.startedAt, sql`date_trunc('month', now())`));
      const [ent] = t ? await db.select({ limits: schema.planEntitlements.limits }).from(schema.planEntitlements).where(eq(schema.planEntitlements.plan, t.plan)) : [];
      const planBudget = (ent?.limits as { budgetCents?: number } | undefined)?.budgetCents ?? 0;
      const weights: Weights = w ? { version: w.version, ...(w.weights as Omit<Weights, 'version' | 'boundaries'>), boundaries: w.boundaries as Weights['boundaries'] } : DEFAULT_WEIGHTS;
      return {
        preset: (PRESET_MODES as readonly string[]).includes(settings.policyPreset ?? '') ? (settings.policyPreset as PresetMode) : 'balanced',
        activeBundleVersion: active?.version ?? null,
        weights,
        orgDomains: new Set([...domains.map((r) => r.d), ...(settings.orgDomains ?? []).map((d) => d.toLowerCase())].filter(Boolean)),
        // 0 = no cap. A tenant's own cap (settings.budgetCents, `budgets.manage`) overrides the plan's.
        budget: { monthCents: Number(spend?.c ?? 0), limitCents: settings.budgetCents ?? planBudget },
        at: this.now(),
      } satisfies TenantFacts;
    });
    this.facts.set(tenantId, facts);
    return facts;
  }

  private async principalRole(tenantId: string, userId: string): Promise<Role> {
    const key = `${tenantId}:${userId}`;
    const hit = this.roles.get(key);
    if (hit && this.now() - hit.at < (this.opts.cacheTtlMs ?? 5_000)) return hit.role;
    const [u] = await withTenant(tenantId, (db) => db.select({ role: schema.users.role }).from(schema.users).where(eq(schema.users.id, userId)));
    const role = (u && ROLES.has(u.role) ? u.role : 'MEMBER') as Role;
    this.roles.set(key, { role, at: this.now() });
    return role;
  }

  // ------------------------------------------------------------------ classification
  /** The content a step is about to send or write: every string argument but the recipients. */
  static generatedContent(ctx: Pick<StepContext, 'args' | 'tool'>): string {
    const out: string[] = [];
    const walk = (v: unknown, path: string) => {
      if (ctx.tool.recipientArgs.some((r) => underRecipient(path, r))) return;
      if (typeof v === 'string') out.push(v);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
    };
    walk(ctx.args, '');
    return out.join('\n').slice(0, MAX_CLASSIFY_CHARS);
  }

  /** Classify (and cache) content for a tenant — the internal `/internal/classify` endpoint. */
  async classify(tenantId: string, text: string): Promise<Classification | null> {
    if (!text.trim()) return null;
    const digest = digestOf(text);
    const [cached] = await withTenant(tenantId, (db) =>
      db
        .select()
        .from(schema.classifications)
        .where(eq(schema.classifications.contentDigest, digest)),
    );
    if (cached) return { digest, entities: cached.entities as Classification['entities'], sensitivity: cached.sensitivity, labels: cached.labels };
    const c = await this.opts.classifier.classify(text);
    await withTenant(tenantId, (db) =>
      db
        .insert(schema.classifications)
        .values({ tenantId, contentDigest: c.digest, entities: c.entities, sensitivity: c.sensitivity, labels: c.labels, classifier: this.opts.classifierName })
        .onConflictDoNothing(),
    );
    return c;
  }

  // ------------------------------------------------------------------ the facts of one action
  static recipientsOf(ctx: Pick<StepContext, 'args' | 'tool'>): string[] {
    const out: string[] = [];
    const take = (v: unknown) => {
      if (typeof v === 'string' && v.trim()) out.push(v.trim());
      else if (Array.isArray(v)) v.forEach(take);
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (typeof o['email'] === 'string') out.push(o['email']);
        else if (typeof o['id'] === 'string') out.push(o['id']);
      }
    };
    for (const r of ctx.tool.recipientArgs) {
      let cur: unknown = ctx.args;
      for (const seg of r.split('.')) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[seg] : undefined;
      take(cur);
    }
    return out;
  }

  private static recipientTaint(ctx: StepContext): Taint {
    let t: Taint = 'TRUSTED';
    for (const a of ctx.argTaints) {
      if (!ctx.tool.recipientArgs.some((r) => underRecipient(a.path, r))) continue;
      const d = a.dataTaint as Taint;
      if (TAINT_ORDER[d] > TAINT_ORDER[t]) t = d;
    }
    return t;
  }

  private static monetary(args: Record<string, unknown>): { amount: number; currency: string } | undefined {
    const a = args['amount'];
    if (typeof a === 'number' && Number.isFinite(a)) return { amount: a, currency: typeof args['currency'] === 'string' ? args['currency'] : 'USD' };
    if (a && typeof a === 'object' && typeof (a as { value?: unknown }).value === 'number') {
      const o = a as { value: number; currency?: unknown };
      return { amount: o.value, currency: typeof o.currency === 'string' ? o.currency : 'USD' };
    }
    return undefined;
  }

  private async inScope(ctx: StepContext): Promise<boolean> {
    if (!ctx.connectorId || !ctx.tool.scopes.length) return true;
    const [c] = await withTenant(ctx.tenantId, (db) => db.select({ granted: schema.connectors.scopesGranted }).from(schema.connectors).where(eq(schema.connectors.id, ctx.connectorId!)));
    if (!c) return false;
    return ctx.tool.scopes.every((s) => c.granted.includes(s));
  }

  /** Builds both inputs: the risk function's and OPA's. Exposed for simulation and tests. */
  async inputs(ctx: StepContext): Promise<{ risk: RiskInput; facts: TenantFacts; classification: Classification | null; audience: string; recipients: string[]; domains: string[] }> {
    const facts = await this.tenantFacts(ctx.tenantId);
    const [role, classification, inScope] = await Promise.all([
      this.principalRole(ctx.tenantId, ctx.principalUserId),
      ctx.tool.reversibility === 'R0' ? Promise.resolve(null) : this.classify(ctx.tenantId, PolicyEngine.generatedContent(ctx)),
      this.inScope(ctx),
    ]);
    const recipients = PolicyEngine.recipientsOf(ctx);
    const domainOf = (r: string) => (r.includes('@') ? r.split('@').pop()!.toLowerCase() : null);
    const domains = [...new Set(recipients.map(domainOf).filter((d): d is string => Boolean(d)))].sort();
    const external = recipients.filter((r) => {
      const d = domainOf(r);
      return !d || !facts.orgDomains.has(d);
    });
    let audience: string;
    if (ctx.tool.egressClass === 'PUBLIC') audience = 'PUBLIC';
    else if (!recipients.length) audience = 'NONE';
    else if (!external.length) audience = 'INTERNAL';
    else {
      const emails = external.filter((r) => r.includes('@')).map((r) => r.toLowerCase());
      const known =
        emails.length === external.length
          ? await withTenant(ctx.tenantId, (db) =>
              db
                .select({ email: sql<string>`lower(${schema.trustedContacts.email})` })
                .from(schema.trustedContacts)
                .where(inArray(sql`lower(${schema.trustedContacts.email})`, emails)),
            )
          : [];
      audience = known.length && new Set(known.map((k) => k.email)).size === new Set(emails).size ? 'CLIENT' : 'EXTERNAL';
    }
    const monetaryValue = PolicyEngine.monetary(ctx.args);
    const prior = ctx.tool.sensitivityHint;
    const messaging = ctx.tool.recipientArgs.length > 0;
    const risk: RiskInput = {
      sensitivity: classification ? Math.max(classification.sensitivity, Math.round(prior / 2)) : prior,
      labels: classification?.labels ?? [],
      effect: { recipients: recipients.length, externalRecipients: external.length, recordsAffected: ctx.tool.reversibility === 'R0' || messaging ? 0 : 1, ...(monetaryValue ? { monetaryValue } : {}) },
      egressClass: ctx.tool.egressClass === 'EXTERNAL' && audience === 'INTERNAL' ? 'INTERNAL' : ctx.tool.egressClass,
      reversibility: ctx.tool.reversibility,
      principalRole: role,
      argTaint: ctx.argTaint,
      recipientTaint: PolicyEngine.recipientTaint(ctx),
      inScope,
    };
    return { risk, facts, classification, audience, recipients, domains };
  }

  static policyInput(ctx: StepContext, x: { risk: RiskInput; facts: TenantFacts; audience: string; domains: string[] }, scored: RiskResult): PolicyInput {
    return {
      tool: { id: ctx.toolId, connector: ctx.tool.connectorKind, egress_class: ctx.tool.egressClass, reversibility: ctx.tool.reversibility, idempotency: ctx.tool.idempotency },
      args: { taint: ctx.argTaint, recipient: { taint: x.risk.recipientTaint, count: x.risk.effect.recipients, domains: x.domains } },
      target: { audience: x.audience },
      effect: {
        recipients: x.risk.effect.recipients,
        external_recipients: x.risk.effect.externalRecipients,
        records: x.risk.effect.recordsAffected,
        fidelity: ctx.tool.simulateFidelity,
        ...(x.risk.effect.monetaryValue ? { monetary_value: x.risk.effect.monetaryValue } : {}),
      },
      data: { sensitivity: x.risk.sensitivity, labels: x.risk.labels },
      risk: { score: scored.score, tier: scored.tier },
      principal: { role: x.risk.principalRole, id: ctx.principalUserId },
      agent: { id: ctx.agentId },
      workspace: { id: ctx.workspaceId },
      run: { trigger: ctx.trigger, cost_cents: ctx.runCostCents },
      budget: {
        month_cents: x.facts.budget.monthCents,
        month_limit_cents: x.facts.budget.limitCents,
        exhausted: x.facts.budget.limitCents > 0 && x.facts.budget.monthCents >= x.facts.budget.limitCents,
      },
    };
  }

  // ------------------------------------------------------------------ the decision
  async decide(ctx: StepContext): Promise<PolicyDecision> {
    const t0 = performance.now();
    let stage = 'input';
    let x: Awaited<ReturnType<PolicyEngine['inputs']>> | undefined;
    let scored: RiskResult | undefined;
    let input: PolicyInput | undefined;
    try {
      x = await this.inputs(ctx);
      stage = 'score';
      scored = scoreRisk(x.risk, x.facts.weights);
      input = PolicyEngine.policyInput(ctx, x, scored);
      stage = 'opa';
      const presetPkg = packageFor({ kind: 'preset', name: x.facts.preset });
      const [preset, tenant] = await Promise.all([
        this.opts.opa.query(presetPkg, input, { require: true }),
        // No activated bundle: the tenant package is simply absent. An activated one that OPA has
        // not loaded is an outage (require), never "no policies".
        x.facts.activeBundleVersion !== null ? this.opts.opa.query(tenantPackage(ctx.tenantId), input, { require: true }) : Promise.resolve({ matches: [] as Match[], bundles: {} as Record<string, string> }),
      ]);
      const bundles = { ...preset.bundles, ...tenant.bundles };
      const tenantRevision = bundles[tenantBundleName(ctx.tenantId)] ?? null;
      stage = 'combine';
      const combined = combine(scored, [...preset.matches, ...tenant.matches]);
      const latencyMs = Math.round(performance.now() - t0);
      stage = 'record';
      const recorded = await this.record(ctx, { x, scored, input, combined, latencyMs, bundleVersion: versionOfRevision(tenantRevision) ?? (x.facts.activeBundleVersion !== null && !tenantRevision ? x.facts.activeBundleVersion : 0), bundleRevision: tenantRevision ?? bundles[PRESETS_BUNDLE] ?? null });
      return toDecision(combined, recorded);
    } catch (e) {
      return this.failClosed(ctx, stage, e, { x, scored, input, t0 });
    }
  }

  private async record(
    ctx: StepContext,
    r: { x: Awaited<ReturnType<PolicyEngine['inputs']>>; scored: RiskResult; input: PolicyInput; combined: CombinedDecision; latencyMs: number; bundleVersion: number; bundleRevision: string | null },
  ): Promise<string> {
    const { combined, scored } = r;
    return withTenant(ctx.tenantId, async (db) => {
      const [risk] = await db
        .insert(schema.riskEvaluations)
        .values({
          tenantId: ctx.tenantId,
          runId: ctx.runId,
          nodeId: ctx.nodeRowId,
          score: scored.score,
          tier: scored.tier,
          weightsVersion: scored.weightsVersion,
          inputJson: r.x.risk,
          factorsJson: scored.factors,
          explanationJson: { explanation: scored.explanation, scoreTier: scored.scoreTier },
          hardGate: scored.hardGates[0] ?? null,
          hardGates: scored.hardGates,
        })
        .returning({ id: schema.riskEvaluations.id });
      const [ev] = await db
        .insert(schema.policyEvaluations)
        .values({
          tenantId: ctx.tenantId,
          runId: ctx.runId,
          nodeId: ctx.nodeRowId,
          dslNodeId: ctx.nodeId,
          toolId: ctx.toolId,
          bundleVersion: r.bundleVersion,
          bundleRevision: r.bundleRevision,
          preset: r.x.facts.preset,
          policyKey: combined.decidedBy.key,
          policyVersion: combined.decidedBy.version,
          decision: combined.decision,
          approverRole: combined.approverRole,
          holdWindowMs: combined.holdWindowMs,
          reasonJson: combined.chain,
          inputJson: r.input,
          matchesJson: combined.matched,
          riskEvaluationId: risk!.id,
          latencyMs: r.latencyMs,
        })
        .returning({ id: schema.policyEvaluations.id });
      const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
      const base = { runId: ctx.runId, nodeId: ctx.nodeRowId, toolId: ctx.toolId, evaluationId: ev!.id, riskScore: scored.score, riskTier: scored.tier };
      if (combined.decision === 'DENY') events.push({ kind: 'policy.denied_action', payload: { ...base, decidedBy: combined.decidedBy.key, reason: reasonOf(combined) } });
      if (scored.tier === 'CRITICAL') events.push({ kind: 'risk.critical', payload: { ...base, hardGates: scored.hardGates } });
      for (const e of events) await db.insert(schema.platformEvents).values({ tenantId: ctx.tenantId, actorId: null, kind: e.kind, payload: e.payload });
      return ev!.id;
    });
  }

  private async failClosed(ctx: StepContext, stage: string, e: unknown, partial: { x?: Awaited<ReturnType<PolicyEngine['inputs']>> | undefined; scored?: RiskResult | undefined; input?: PolicyInput | undefined; t0: number }): Promise<PolicyDecision> {
    const message = e instanceof Error ? e.message : String(e);
    const reason = `${stage}: ${message}`;
    const combined = failClosed(reason, partial.scored);
    this.opts.log.error({ alert: true, err: e, stage, tenant_id: ctx.tenantId, run_id: ctx.runId, tool_id: ctx.toolId }, 'POLICY ENGINE UNAVAILABLE — action denied (fail closed)');
    let evaluationId: string | undefined;
    try {
      evaluationId = await withTenant(ctx.tenantId, async (db) => {
        const [ev] = await db
          .insert(schema.policyEvaluations)
          .values({
            tenantId: ctx.tenantId,
            runId: ctx.runId,
            nodeId: ctx.nodeRowId,
            dslNodeId: ctx.nodeId,
            toolId: ctx.toolId,
            preset: partial.x?.facts.preset ?? 'balanced',
            policyKey: combined.decidedBy.key,
            policyVersion: 0,
            decision: 'DENY',
            reasonJson: combined.chain,
            inputJson: partial.input ?? {},
            matchesJson: [],
            failClosed: true,
            latencyMs: Math.round(performance.now() - partial.t0),
          })
          .returning({ id: schema.policyEvaluations.id });
        await db.insert(schema.platformEvents).values({ tenantId: ctx.tenantId, actorId: null, kind: 'policy.unavailable', payload: { runId: ctx.runId, nodeId: ctx.nodeRowId, toolId: ctx.toolId, stage, reason: message.slice(0, 500) } });
        return ev!.id;
      });
    } catch (recordError) {
      // The database may be what failed. The DENY stands regardless; the log line is the record.
      this.opts.log.error({ alert: true, err: recordError, run_id: ctx.runId }, 'a fail-closed policy decision could not be recorded');
    }
    await this.opts.alerter?.alert({ kind: 'policy.unavailable', tenantId: ctx.tenantId, runId: ctx.runId, toolId: ctx.toolId, message: reason }).catch(() => undefined);
    return { ...toDecision(combined, evaluationId), failClosed: true };
  }
}

/** The human sentence for the pending card: the deciding rule's own line of the chain. */
function reasonOf(c: CombinedDecision): string {
  const key = c.decidedBy.key;
  const step = key.startsWith('(hard-gate:')
    ? c.chain.find((s) => s.step === 'gate' && `(hard-gate:${s.id})` === key)
    : key.startsWith('(tier-default:')
      ? c.chain.find((s) => s.step === 'tier')
      : key === '(fail-closed)'
        ? c.chain.find((s) => s.step === 'engine')
        : c.chain.find((s) => s.step === 'policy' && s.id === key);
  return step?.detail ?? c.chain.find((s) => s.step === 'combine')?.detail ?? c.decision;
}

function toDecision(c: CombinedDecision, evaluationId: string | undefined): PolicyDecision {
  const chain: ReasonStep[] = c.chain.map((s) => ({ step: s.step, detail: s.detail, ...(s.id ? { id: s.id } : {}), ...(s.version ? { version: s.version } : {}), ...(s.citation ? { citation: s.citation } : {}) }));
  return {
    decision: c.decision,
    reason: reasonOf(c),
    riskScore: c.riskScore,
    riskTier: c.riskTier,
    policyIds: c.matched.map((m) => m.id),
    approverRole: c.approverRole,
    holdWindowMs: c.holdWindowMs,
    separationOfDuties: c.separationOfDuties,
    chain,
    ...(evaluationId ? { evaluationId } : {}),
    ...(c.failClosed ? { failClosed: true } : {}),
  };
}
