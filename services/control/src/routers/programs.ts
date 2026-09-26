import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import { problems } from '@vega/shared';
import { schema } from '@vega/db';
import { Uuid } from '@vega/contracts';
import { ProblemError, procedure, requireCapability, router, type AuthedContext } from '../trpc.js';
import { emitEvent, isUniqueViolation } from '../lib.js';
import { asProblem, connectorDeps } from '../connectors/common.js';

/**
 * Programs, provenance and taint violations — docs/module3.md §4, §8.
 *
 * `dryRun` runs a program through the capability interpreter in SIMULATE mode: every tool's
 * simulate(), the full gate, provenance recorded — no side effects. It is how a person (and,
 * from Module 4, the Agent Studio) sees what a plan would do and why before anything happens.
 * Real execution is Module 4's orchestrator; there is no execute here.
 */

const ProgramInput = z.union([z.string().min(1).max(200_000), z.record(z.string(), z.unknown())]);

/** Binds each connector kind a program uses to one of the tenant's active connectors. */
async function bindingsFor(ctx: AuthedContext, explicit: Record<string, string>): Promise<Record<string, string>> {
  const rows = await ctx.db((db) =>
    db.select({ id: schema.connectors.id, kind: schema.connectors.kind, config: schema.connectors.config, status: schema.connectors.status }).from(schema.connectors).where(eq(schema.connectors.status, 'active')).orderBy(asc(schema.connectors.createdAt)),
  );
  const out: Record<string, string> = {};
  for (const r of rows) {
    const key = r.kind === 'mcp' ? `mcp.${String((r.config as { slug?: string }).slug ?? '')}` : r.kind;
    out[key] ??= r.id;
  }
  for (const [k, id] of Object.entries(explicit)) {
    if (!rows.some((r) => r.id === id)) throw new ProblemError(problems.validation([{ path: `bindings.${k}`, message: 'not an active connector in this tenant' }]));
    out[k] = id;
  }
  return out;
}

export const programsRouter = router({
  catalog: procedure.query(async ({ ctx }) => {
    requireCapability(ctx, 'agents.read');
    try {
      return await connectorDeps(ctx).execution.programCatalog();
    } catch (error) {
      return asProblem(error);
    }
  }),

  validate: procedure.input(z.object({ program: ProgramInput })).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'agents.read');
    try {
      return await connectorDeps(ctx).execution.validateProgram(ctx.principal.tenantId, input.program);
    } catch (error) {
      return asProblem(error);
    }
  }),

  dryRun: procedure
    .input(z.object({ program: ProgramInput, objective: z.string().max(4000).optional(), bindings: z.record(z.string(), Uuid).default({}) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx, 'agents.run');
      const runId = `dry-${randomUUID()}`;
      try {
        const result = await connectorDeps(ctx).execution.runProgram({
          tenantId: ctx.principal.tenantId,
          runId,
          program: input.program,
          mode: 'simulate',
          modelId: 'human-authored',
          now: new Date().toISOString(),
          bindings: await bindingsFor(ctx, input.bindings),
          ...(input.objective ? { objective: input.objective } : {}),
        });
        return { runId, ...result };
      } catch (error) {
        return asProblem(error);
      }
    }),

  /** The provenance DAG for a run (docs/module3.md §8.3): sources → derivations → actions. */
  provenance: procedure.input(z.object({ runId: z.string().min(1).max(200) })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'agents.read');
    const [derivations, sources, violations, programs] = await ctx.db(async (db) =>
      Promise.all([
        db.select().from(schema.derivations).where(eq(schema.derivations.runId, input.runId)).orderBy(asc(schema.derivations.stepIndex)).limit(5_000),
        db.select().from(schema.sources).where(eq(schema.sources.runId, input.runId)).limit(1_000),
        db.select().from(schema.taintViolations).where(eq(schema.taintViolations.runId, input.runId)),
        db.select({ digest: schema.programs.astDigest, ast: schema.programs.astJson, modelId: schema.programs.modelId, valid: schema.programs.valid }).from(schema.programs).where(eq(schema.programs.runId, input.runId)),
      ]),
    );
    if (!derivations.length && !programs.length) throw new ProblemError(problems.notFound('no such run'));
    return {
      runId: input.runId,
      program: programs[0] ?? null,
      nodes: derivations.map((d) => ({ valueRef: d.valueRef, op: d.op, taint: d.taint, dataTaint: d.dataTaint, contextTaint: d.contextTaint, nodeId: d.nodeId, sourceIds: d.sourceIds, step: d.stepIndex })),
      edges: derivations.flatMap((d) => d.inputRefs.map((from) => ({ from, to: d.valueRef }))),
      sources: [...new Map(sources.map((s) => [s.uri, { uri: s.uri, taint: s.taint, digest: s.digest }])).values()],
      violations: violations.map((v) => ({ id: v.id, nodeId: v.nodeId, toolId: v.toolId, kind: v.kind, argPath: v.argPath, severity: v.severity, detail: v.detail })),
    };
  }),
});

export const securityRouter = router({
  /** Taint violations — security incidents (docs/module3.md §8.4), newest first. */
  violations: procedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50), before: z.string().datetime({ offset: true }).optional(), unacknowledged: z.boolean().default(false) }))
    .query(async ({ ctx, input }) => {
      requireCapability(ctx, 'audit.read');
      const rows = await ctx.db((db) =>
        db
          .select()
          .from(schema.taintViolations)
          .where(and(input.before ? lt(schema.taintViolations.createdAt, new Date(input.before)) : undefined, input.unacknowledged ? isNull(schema.taintViolations.acknowledgedAt) : undefined))
          .orderBy(desc(schema.taintViolations.createdAt))
          .limit(input.limit),
      );
      return {
        items: rows.map((v) => ({
          id: v.id,
          runId: v.runId,
          nodeId: v.nodeId,
          toolId: v.toolId,
          kind: v.kind,
          attemptedTaint: v.attemptedTaint,
          declaredMax: v.declaredMax,
          argPath: v.argPath,
          sourceIds: v.sourceIds,
          programRef: v.programRef,
          severity: v.severity,
          detail: v.detail,
          acknowledgedAt: v.acknowledgedAt?.toISOString() ?? null,
          createdAt: v.createdAt.toISOString(),
        })),
      };
    }),

  acknowledge: procedure.input(z.object({ id: Uuid })).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'policy.manage');
    const [row] = await ctx.db(async (db) => {
      const r = await db
        .update(schema.taintViolations)
        .set({ acknowledgedBy: ctx.principal.userId, acknowledgedAt: new Date() })
        .where(eq(schema.taintViolations.id, input.id))
        .returning({ id: schema.taintViolations.id });
      if (r.length) await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'security.taint_violation_acknowledged', { violationId: input.id });
      return r;
    });
    if (!row) throw new ProblemError(problems.notFound('violation not found'));
    return { ok: true };
  }),
});

const Email = z.string().trim().toLowerCase().email().max(320);

/** The `contacts` registry `resolve` endorses from: who the tenant has decided to trust. */
export const contactsRouter = router({
  list: procedure.query(async ({ ctx }) => {
    requireCapability(ctx, 'connectors.read');
    const rows = await ctx.db((db) => db.select().from(schema.trustedContacts).orderBy(asc(schema.trustedContacts.email)));
    return { items: rows.map((r) => ({ id: r.id, email: r.email, displayName: r.displayName, company: r.company, createdAt: r.createdAt.toISOString() })) };
  }),

  add: procedure.input(z.object({ email: Email, displayName: z.string().trim().max(200).optional(), company: z.string().trim().max(200).optional() })).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'connectors.manage');
    try {
      const [row] = await ctx.db(async (db) => {
        const r = await db
          .insert(schema.trustedContacts)
          .values({ tenantId: ctx.principal.tenantId, email: input.email, displayName: input.displayName ?? null, company: input.company ?? null, addedBy: ctx.principal.userId })
          .returning();
        await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'contacts.trusted_added', { email: input.email });
        return r;
      });
      return { id: row!.id, email: row!.email, displayName: row!.displayName, company: row!.company, createdAt: row!.createdAt.toISOString() };
    } catch (error) {
      if (isUniqueViolation(error)) throw new ProblemError(problems.conflict('already a trusted contact'));
      throw error;
    }
  }),

  remove: procedure.input(z.object({ id: Uuid })).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'connectors.manage');
    const r = await ctx.db((db) => db.delete(schema.trustedContacts).where(eq(schema.trustedContacts.id, input.id)).returning({ email: schema.trustedContacts.email }));
    if (!r.length) throw new ProblemError(problems.notFound('contact not found'));
    await ctx.db((db) => emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'contacts.trusted_removed', { email: r[0]!.email }));
    return { ok: true };
  }),
});
