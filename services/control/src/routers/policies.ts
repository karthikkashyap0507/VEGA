import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, ne, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Db } from '@vega/db';
import { Uuid } from '@vega/contracts';
import { launchRegistry } from '@vega/connectors';
import { problems } from '@vega/shared';
import { compileModule, compilePolicy, FIELDS, parsePolicyYaml, PolicyError, PRESET_MODES, PRESET_YAML, PROFESSIONAL_SERVICES_PACK, tenantPackage, type Policy, type PolicyInput, type PresetMode } from '@vega/policy-engine';
import type { RiskInput, Weights } from '@vega/risk';
import { emitEvent } from '../lib.js';
import { lineDiff } from '../policy/diff.js';
import type { PolicyPublisher } from '../policy/publisher.js';
import { simulate, type SimulationReport, type StoredEvaluation } from '../policy/simulate.js';
import { ProblemError, procedure, requireCapability, requireExposed, router, type AuthedContext } from '../trpc.js';

/**
 * THE POLICY CONSOLE's API (docs/module5.md §6.1, §7, §8.2).
 *
 *   author   YAML only (raw Rego is refused) → validated → compiled → a DRAFT version
 *   build    the working set (latest non-retiring version of every key) → a signed CANDIDATE bundle
 *   simulate the candidate against up to 90 days of recorded actions (REQUIRED before activation)
 *   activate the candidate's signed bytes become what OPA polls; the previous bundle is superseded
 *
 * Nothing is ever deleted: a retired policy keeps its rows (audit history depends on them), and
 * every activation is a platform event (`policy.activated`, also a webhook kind).
 *
 * Reading needs `policy.read`; authoring, simulating and activating need `policy.manage` (ADMIN,
 * OWNER — module5.md §10) and a plan that exposes policy authoring. Choosing a PRESET is open to
 * every plan: that is how self-serve tiers get the same engine (§5.7, D-09).
 */

const MAX_WINDOW_DAYS = 90;
export const PACKS = { 'professional-services': PROFESSIONAL_SERVICES_PACK } as const;

type PolicyRow = typeof schema.policies.$inferSelect;
type BundleRow = typeof schema.policyBundles.$inferSelect;

const policyView = (p: PolicyRow) => ({
  id: p.id,
  key: p.key,
  version: p.version,
  state: p.state,
  description: p.description,
  citation: p.citation,
  severity: p.severity,
  decision: p.decision,
  specYaml: p.specYaml,
  compiledRego: p.compiledRego,
  activeFrom: p.activeFrom?.toISOString() ?? null,
  activeTo: p.activeTo?.toISOString() ?? null,
  /** Scheduled to retire: excluded from the next bundle, still enforced until it activates. */
  retiring: p.activeTo !== null && p.state !== 'retired',
  createdAt: p.createdAt.toISOString(),
});

const bundleView = (b: BundleRow, sim?: { id: string; createdAt: Date; summary: unknown } | undefined) => ({
  id: b.id,
  version: b.version,
  revision: b.revision,
  digest: b.digest,
  policies: b.policyVersions as Array<{ key: string; version: number }>,
  state: b.activatedAt ? (b.supersededAt ? 'superseded' : 'active') : 'candidate',
  createdAt: b.createdAt.toISOString(),
  activatedAt: b.activatedAt?.toISOString() ?? null,
  supersededAt: b.supersededAt?.toISOString() ?? null,
  simulation: sim ? { id: sim.id, createdAt: sim.createdAt.toISOString(), summary: sim.summary } : null,
});

function publisherOf(ctx: AuthedContext): PolicyPublisher {
  const p = ctx.deps.policy?.publisher;
  if (!p) throw new ProblemError(problems.upstreamUnavailable('policy distribution (object storage + bundle signing key)'));
  return p;
}

function manage(ctx: AuthedContext) {
  requireCapability(ctx, 'policy.manage');
  requireExposed(ctx, 'policyAuthoring');
}

/** Parses the editor's YAML into exactly one policy, or a validation problem with every issue. */
function parseOne(yaml: string, expectKey?: string): Policy {
  let policies: Policy[];
  try {
    policies = parsePolicyYaml(yaml);
  } catch (e) {
    if (e instanceof PolicyError) throw new ProblemError(problems.validation(e.problems));
    throw e;
  }
  if (policies.length !== 1) throw new ProblemError(problems.validation([{ path: 'yaml', message: 'one policy per document: author, version and retire policies one at a time' }]));
  const p = policies[0]!;
  if (expectKey && p.id !== expectKey) throw new ProblemError(problems.validation([{ path: 'id', message: `a new version keeps its id (${expectKey}); a different id is a different policy` }]));
  return p;
}

const rowValues = (tenantId: string, p: Policy, version: number, yaml: string, authorId: string) => ({
  tenantId,
  key: p.id,
  version,
  specYaml: yaml.trim() + '\n',
  compiledRego: compilePolicy(p, version),
  citation: p.citation ?? null,
  description: p.description,
  severity: p.severity,
  decision: p.then.decision,
  authorId,
});

/** The rows a bundle names, parsed back from their YAML (the source of truth). */
async function policiesOf(db: Db, refs: Array<{ key: string; version: number }>): Promise<Array<{ policy: Policy; version: number; row: PolicyRow }>> {
  if (!refs.length) return [];
  const rows = await db.select().from(schema.policies).where(inArray(schema.policies.key, refs.map((r) => r.key)));
  return refs.map((r) => {
    const row = rows.find((x) => x.key === r.key && x.version === r.version);
    if (!row) throw new ProblemError(problems.conflict(`policy ${r.key} v${r.version} is missing`));
    return { policy: parsePolicyYaml(row.specYaml)[0]!, version: r.version, row };
  });
}

/** The working set: per key, the latest version — unless that key is retired or retiring. */
async function workingSet(db: Db): Promise<PolicyRow[]> {
  const latest = await db.selectDistinctOn([schema.policies.key]).from(schema.policies).orderBy(schema.policies.key, desc(schema.policies.version));
  return latest.filter((p) => p.state !== 'retired' && p.activeTo === null);
}

async function activeBundle(db: Db): Promise<BundleRow | undefined> {
  const [b] = await db
    .select()
    .from(schema.policyBundles)
    .where(and(isNotNull(schema.policyBundles.activatedAt), isNull(schema.policyBundles.supersededAt)));
  return b;
}

async function presetOf(db: Db, tenantId: string): Promise<PresetMode> {
  const [t] = await db.select({ settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
  const p = (t?.settings as { policyPreset?: string } | null)?.policyPreset;
  return (PRESET_MODES as readonly string[]).includes(p ?? '') ? (p as PresetMode) : 'balanced';
}

export const policiesRouter = router({
  /** Latest version of every policy (filterable by state), with the version currently enforced. */
  list: procedure.input(z.object({ state: z.enum(['draft', 'simulated', 'active', 'retired']).optional() }).optional()).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'policy.read');
    return ctx.db(async (db) => {
      const latest = await db.selectDistinctOn([schema.policies.key]).from(schema.policies).orderBy(schema.policies.key, desc(schema.policies.version));
      const active = await db.select({ key: schema.policies.key, version: schema.policies.version }).from(schema.policies).where(eq(schema.policies.state, 'active'));
      const items = latest
        .filter((p) => !input?.state || p.state === input.state)
        .map((p) => ({ ...policyView(p), activeVersion: active.find((a) => a.key === p.key)?.version ?? null }));
      const bundle = await activeBundle(db);
      return { items, preset: await presetOf(db, ctx.principal.tenantId), activeBundle: bundle ? { id: bundle.id, version: bundle.version, activatedAt: bundle.activatedAt!.toISOString() } : null };
    });
  }),

  versions: procedure.input(z.object({ key: z.string().min(2).max(64) })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'policy.read');
    const rows = await ctx.db((db) => db.select().from(schema.policies).where(eq(schema.policies.key, input.key)).orderBy(desc(schema.policies.version)));
    if (!rows.length) throw new ProblemError(problems.notFound(`no policy ${input.key}`));
    return { key: input.key, versions: rows.map(policyView) };
  }),

  diff: procedure.input(z.object({ key: z.string().min(2).max(64), from: z.number().int().min(1), to: z.number().int().min(1) })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'policy.read');
    const rows = await ctx.db((db) => db.select().from(schema.policies).where(and(eq(schema.policies.key, input.key), inArray(schema.policies.version, [input.from, input.to]))));
    const a = rows.find((r) => r.version === input.from);
    const b = rows.find((r) => r.version === input.to);
    if (!a || !b) throw new ProblemError(problems.notFound(`${input.key}: version ${!a ? input.from : input.to} does not exist`));
    return { key: input.key, from: policyView(a), to: policyView(b), lines: lineDiff(a.specYaml, b.specYaml), rego: lineDiff(a.compiledRego, b.compiledRego) };
  }),

  /** The editor's live check: validation problems with paths, or the Rego it compiles to. */
  compile: procedure.input(z.object({ yaml: z.string().max(20_000) })).mutation(({ ctx, input }) => {
    requireCapability(ctx, 'policy.read');
    try {
      const policies = parsePolicyYaml(input.yaml);
      return { ok: true as const, policies: policies.map((p) => ({ id: p.id, decision: p.then.decision, severity: p.severity, citation: p.citation ?? null })), rego: compileModule(tenantPackage(ctx.principal.tenantId), policies.map((policy) => ({ policy, version: 1 }))) };
    } catch (e) {
      if (e instanceof PolicyError) return { ok: false as const, problems: e.problems };
      throw e;
    }
  }),

  /** Autocomplete: the fields a condition may test and every tool id. */
  vocabulary: procedure.query(({ ctx }) => {
    requireCapability(ctx, 'policy.read');
    return { fields: Object.entries(FIELDS).map(([field, f]) => ({ field, ...f })), tools: launchRegistry().records().map((r) => r.toolId), presets: PRESET_MODES, packs: Object.keys(PACKS) };
  }),

  create: procedure.input(z.object({ yaml: z.string().min(1).max(20_000) })).mutation(async ({ ctx, input }) => {
    manage(ctx);
    const p = parseOne(input.yaml);
    return ctx.db(async (db) => {
      const [exists] = await db.select({ id: schema.policies.id }).from(schema.policies).where(eq(schema.policies.key, p.id)).limit(1);
      if (exists) throw new ProblemError(problems.conflict(`policy ${p.id} exists: publish a new version instead`));
      const [row] = await db.insert(schema.policies).values(rowValues(ctx.principal.tenantId, p, 1, input.yaml, ctx.principal.userId)).returning();
      await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'policy.created', { key: p.id, version: 1 });
      return policyView(row!);
    });
  }),

  /** A new version (a draft). Earlier versions are never edited. */
  update: procedure.input(z.object({ key: z.string().min(2).max(64), yaml: z.string().min(1).max(20_000) })).mutation(async ({ ctx, input }) => {
    manage(ctx);
    const p = parseOne(input.yaml, input.key);
    return ctx.db(async (db) => {
      const [last] = await db.select().from(schema.policies).where(eq(schema.policies.key, input.key)).orderBy(desc(schema.policies.version)).limit(1);
      if (!last) throw new ProblemError(problems.notFound(`no policy ${input.key}`));
      if (last.specYaml.trim() === input.yaml.trim()) throw new ProblemError(problems.validation([{ path: 'yaml', message: 'no change from the latest version' }]));
      const [row] = await db.insert(schema.policies).values(rowValues(ctx.principal.tenantId, p, last.version + 1, input.yaml, ctx.principal.userId)).returning();
      await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'policy.versioned', { key: p.id, version: row!.version });
      return policyView(row!);
    });
  }),

  /** Retire with an effective date: out of the next bundle; enforced until that bundle activates. */
  retire: procedure.input(z.object({ key: z.string().min(2).max(64), effectiveAt: z.string().datetime().optional() })).mutation(async ({ ctx, input }) => {
    manage(ctx);
    return ctx.db(async (db) => {
      const at = input.effectiveAt ? new Date(input.effectiveAt) : new Date();
      const rows = await db
        .update(schema.policies)
        .set({ activeTo: at })
        .where(and(eq(schema.policies.key, input.key), ne(schema.policies.state, 'retired')))
        .returning();
      if (!rows.length) throw new ProblemError(problems.notFound(`no policy ${input.key} to retire`));
      await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'policy.retiring', { key: input.key, effectiveAt: at.toISOString() });
      return { key: input.key, effectiveAt: at.toISOString(), note: 'excluded from the next bundle; still enforced until that bundle is activated' };
    });
  }),

  /** Adopts a vertical pack as the tenant's own drafts (skipping keys it already has). */
  installPack: procedure.input(z.object({ pack: z.enum(Object.keys(PACKS) as [keyof typeof PACKS]) })).mutation(async ({ ctx, input }) => {
    manage(ctx);
    const yaml = PACKS[input.pack];
    const parsed = parsePolicyYaml(yaml);
    // Each policy's own YAML, re-serialized from the pack's list item.
    const chunks = yaml.split(/\n(?=- id: )/).map((c) => c.trim()).filter((c) => c.startsWith('- id:'));
    return ctx.db(async (db) => {
      const existing = new Set((await db.selectDistinct({ key: schema.policies.key }).from(schema.policies)).map((r) => r.key));
      const added: string[] = [];
      for (const [i, p] of parsed.entries()) {
        if (existing.has(p.id)) continue;
        const own = chunks[i]!.replace(/^- /, '').replace(/\n {2}/g, '\n');
        await db.insert(schema.policies).values(rowValues(ctx.principal.tenantId, p, 1, own, ctx.principal.userId));
        added.push(p.id);
      }
      await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'policy.pack_installed', { pack: input.pack, added });
      return { pack: input.pack, added, skipped: parsed.map((p) => p.id).filter((id) => !added.includes(id)) };
    });
  }),

  bundles: procedure.query(async ({ ctx }) => {
    requireCapability(ctx, 'policy.read');
    return ctx.db(async (db) => {
      const rows = await db.select().from(schema.policyBundles).orderBy(desc(schema.policyBundles.version)).limit(50);
      const sims = rows.length
        ? await db.select().from(schema.policySimulations).where(inArray(schema.policySimulations.bundleId, rows.map((r) => r.id))).orderBy(desc(schema.policySimulations.createdAt))
        : [];
      return rows.map((b) => {
        const s = sims.find((x) => x.bundleId === b.id);
        return bundleView(b, s ? { id: s.id, createdAt: s.createdAt, summary: s.summaryJson } : undefined);
      });
    });
  }),

  /** Compiles and signs the working set into a candidate bundle (stored, not loaded). */
  buildBundle: procedure.mutation(async ({ ctx }) => {
    manage(ctx);
    const publisher = publisherOf(ctx);
    return ctx.db(async (db) => {
      const set = await workingSet(db);
      const policies = set.map((row) => ({ policy: parsePolicyYaml(row.specYaml)[0]!, version: row.version }));
      const [{ next }] = (await db.select({ next: sql<number>`coalesce(max(${schema.policyBundles.version}), 0) + 1` }).from(schema.policyBundles)) as [{ next: number }];
      const built = await publisher.buildCandidate(ctx.principal.tenantId, Number(next), policies);
      const [row] = await db
        .insert(schema.policyBundles)
        .values({
          tenantId: ctx.principal.tenantId,
          version: Number(next),
          policyIds: set.map((p) => p.id),
          policyVersions: set.map((p) => ({ key: p.key, version: p.version })),
          rego: built.rego,
          revision: built.revision,
          bundleRef: built.ref,
          digest: built.digest,
          signature: built.signature,
          createdBy: ctx.principal.userId,
        })
        .returning();
      await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'policy.bundle_built', { bundleId: row!.id, version: row!.version, policies: set.length });
      return bundleView(row!);
    });
  }),

  /** Replays up to 90 days of recorded actions against a candidate (§5.8). Required to activate. */
  simulate: procedure.input(z.object({ bundleId: Uuid, windowDays: z.number().int().min(1).max(MAX_WINDOW_DAYS).default(MAX_WINDOW_DAYS) })).mutation(async ({ ctx, input }) => {
    manage(ctx);
    return ctx.db(async (db) => {
      const [bundle] = await db.select().from(schema.policyBundles).where(eq(schema.policyBundles.id, input.bundleId));
      if (!bundle) throw new ProblemError(problems.notFound('no such bundle'));
      const active = await activeBundle(db);
      const candidate = await policiesOf(db, bundle.policyVersions as Array<{ key: string; version: number }>);
      const baseline = active ? await policiesOf(db, active.policyVersions as Array<{ key: string; version: number }>) : [];
      const windowTo = new Date();
      const windowFrom = new Date(windowTo.getTime() - input.windowDays * 86_400_000);
      const rows = await db
        .select({ e: schema.policyEvaluations, r: schema.riskEvaluations })
        .from(schema.policyEvaluations)
        .innerJoin(schema.riskEvaluations, eq(schema.riskEvaluations.id, schema.policyEvaluations.riskEvaluationId))
        .where(and(gte(schema.policyEvaluations.evaluatedAt, windowFrom), eq(schema.policyEvaluations.failClosed, false)))
        .orderBy(asc(schema.policyEvaluations.evaluatedAt));
      const weightRows = await db.select().from(schema.riskWeights);
      const weights = new Map<number, Weights>(weightRows.map((w) => [w.version, { version: w.version, ...(w.weights as Omit<Weights, 'version' | 'boundaries'>), boundaries: w.boundaries as Weights['boundaries'] }]));
      const evaluations: StoredEvaluation[] = rows.map(({ e, r }) => ({
        id: e.id,
        runId: e.runId,
        nodeId: e.nodeId,
        toolId: e.toolId,
        preset: e.preset,
        evaluatedAt: e.evaluatedAt,
        input: e.inputJson as PolicyInput,
        risk: r.inputJson as RiskInput,
        weightsVersion: r.weightsVersion,
      }));
      const report: SimulationReport = simulate({ evaluations, weights, baseline, candidate, windowDays: input.windowDays });
      const summary = {
        bundleVersion: bundle.version,
        baselineVersion: active?.version ?? null,
        windowDays: input.windowDays,
        actionsReplayed: report.actionsReplayed,
        unchanged: report.unchanged,
        counts: report.counts,
        topTools: report.topTools,
        approvalsPerWeekDelta: report.approvalsPerWeekDelta,
        truncated: report.truncated,
      };
      const [sim] = await db
        .insert(schema.policySimulations)
        .values({ tenantId: ctx.principal.tenantId, bundleId: bundle.id, baselineBundleId: active?.id ?? null, windowFrom, windowTo, actionsReplayed: report.actionsReplayed, summaryJson: summary, changesJson: report.changes, runBy: ctx.principal.userId })
        .returning();
      // Drafts in a simulated candidate are now "simulated": reviewed against history, not yet live.
      const draftIds = candidate.filter((c) => c.row.state === 'draft').map((c) => c.row.id);
      if (draftIds.length) await db.update(schema.policies).set({ state: 'simulated' }).where(inArray(schema.policies.id, draftIds));
      await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'policy.simulated', { bundleId: bundle.id, simulationId: sim!.id, counts: report.counts });
      return { id: sim!.id, bundleId: bundle.id, summary, changes: report.changes };
    });
  }),

  simulation: procedure.input(z.object({ id: Uuid })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'policy.read');
    const [s] = await ctx.db((db) => db.select().from(schema.policySimulations).where(eq(schema.policySimulations.id, input.id)));
    if (!s) throw new ProblemError(problems.notFound('no such simulation'));
    return { id: s.id, bundleId: s.bundleId, baselineBundleId: s.baselineBundleId, windowFrom: s.windowFrom.toISOString(), windowTo: s.windowTo.toISOString(), actionsReplayed: s.actionsReplayed, summary: s.summaryJson, changes: s.changesJson, createdAt: s.createdAt.toISOString() };
  }),

  /** Activation: REQUIRES an attached simulation (§5.8). The signed candidate becomes what OPA loads. */
  activate: procedure.input(z.object({ bundleId: Uuid })).mutation(async ({ ctx, input }) => {
    manage(ctx);
    const publisher = publisherOf(ctx);
    const out = await ctx.db(async (db) => {
      const [bundle] = await db.select().from(schema.policyBundles).where(eq(schema.policyBundles.id, input.bundleId)).for('update');
      if (!bundle) throw new ProblemError(problems.notFound('no such bundle'));
      if (bundle.activatedAt) throw new ProblemError(problems.preconditionFailed(`bundle v${bundle.version} was already activated`));
      const [sim] = await db.select({ id: schema.policySimulations.id }).from(schema.policySimulations).where(eq(schema.policySimulations.bundleId, bundle.id)).limit(1);
      if (!sim) throw new ProblemError(problems.preconditionFailed('a bundle cannot be activated without a simulation: run one and review what would change'));
      const previous = await activeBundle(db);
      if (previous && previous.version > bundle.version) throw new ProblemError(problems.preconditionFailed(`bundle v${bundle.version} is older than the active v${previous.version}; build a new candidate`));
      const now = new Date();
      if (previous) await db.update(schema.policyBundles).set({ supersededAt: now }).where(eq(schema.policyBundles.id, previous.id));
      await db.update(schema.policyBundles).set({ activatedAt: now, activatedBy: ctx.principal.userId }).where(eq(schema.policyBundles.id, bundle.id));
      // Policy states follow the bundle: in it → active; an earlier active version not in it → retired.
      const inBundle = bundle.policyIds;
      if (inBundle.length) await db.update(schema.policies).set({ state: 'active', activeFrom: sql`coalesce(${schema.policies.activeFrom}, ${now})` }).where(inArray(schema.policies.id, inBundle));
      await db
        .update(schema.policies)
        .set({ state: 'retired', activeTo: sql`coalesce(${schema.policies.activeTo}, ${now})` })
        .where(and(eq(schema.policies.state, 'active'), inBundle.length ? notInArray(schema.policies.id, inBundle) : undefined));
      await db
        .update(schema.policies)
        .set({ state: 'retired' })
        .where(and(isNotNull(schema.policies.activeTo), ne(schema.policies.state, 'retired'), inBundle.length ? notInArray(schema.policies.id, inBundle) : undefined));
      await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'policy.activated', {
        bundleId: bundle.id,
        version: bundle.version,
        previousVersion: previous?.version ?? null,
        digest: bundle.digest,
        simulationId: sim.id,
        policies: bundle.policyVersions,
      });
      // The signed bytes go live inside the transaction: if the copy fails, nothing is activated.
      await publisher.activate(ctx.principal.tenantId, bundle.bundleRef, bundle.digest);
      return { bundle, previous };
    });
    // A tenant's first activation must appear in the discovery bundle before OPA will poll it.
    await publisher.publishDiscovery([ctx.principal.tenantId]);
    ctx.log.info({ bundle: out.bundle.version, previous: out.previous?.version ?? null }, 'policy bundle activated');
    return bundleView({ ...out.bundle, activatedAt: new Date(), activatedBy: ctx.principal.userId });
  }),

  preset: router({
    get: procedure.query(async ({ ctx }) => {
      requireCapability(ctx, 'policy.read');
      const mode = await ctx.db((db) => presetOf(db, ctx.principal.tenantId));
      return { mode, modes: PRESET_MODES.map((m) => ({ mode: m, yaml: PRESET_YAML[m] })) };
    }),
    /** Every plan: the self-serve way to choose behaviour (§5.7). Hard gates apply in all modes. */
    set: procedure.input(z.object({ mode: z.enum(PRESET_MODES as [PresetMode, ...PresetMode[]]) })).mutation(async ({ ctx, input }) => {
      requireCapability(ctx, 'policy.manage');
      return ctx.db(async (db) => {
        const before = await presetOf(db, ctx.principal.tenantId);
        await db
          .update(schema.tenants)
          .set({ settings: sql`jsonb_set(coalesce(${schema.tenants.settings}, '{}'::jsonb), '{policyPreset}', ${JSON.stringify(input.mode)}::jsonb)` })
          .where(eq(schema.tenants.id, ctx.principal.tenantId));
        await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'policy.preset_changed', { from: before, to: input.mode });
        return { mode: input.mode };
      });
    }),
  }),
});
