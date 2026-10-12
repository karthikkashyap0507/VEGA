import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { fga, hasCapability } from '@vega/authz';
import { schema } from '@vega/db';
import { Uuid } from '@vega/contracts';
import { MEMORY_CLASSES, MemoryRejected, type Scope } from '@vega/memory';
import { problems } from '@vega/shared';
import type { KnowledgeService } from '../knowledge/service.js';
import { ProblemError, procedure, requireCapability, requireRelation, router, type AuthedContext, type Context } from '../trpc.js';

/**
 * Module 9 — memory, the knowledge base, verification results and the retrieval inspector
 * (docs/module9.md §8, §9). Memory belongs to its subject: a person controls their own, a
 * workspace's members control the workspace's, and the organization's needs `knowledge.manage`.
 */

function svc(ctx: Context): KnowledgeService {
  if (!ctx.deps.knowledge) throw new ProblemError(problems.upstreamUnavailable('knowledge'));
  return ctx.deps.knowledge;
}

/** Read access to a run (the same rule as the runs API): its principal, its workspace's members, or tenant-wide audit/administration. */
async function readable(ctx: AuthedContext, runId: string): Promise<void> {
  requireCapability(ctx, 'agents.read');
  const [run] = await ctx.db((db) => db.select({ principal: schema.runs.principalUserId, workspaceId: schema.runs.workspaceId }).from(schema.runs).where(eq(schema.runs.id, runId)));
  if (!run) throw new ProblemError(problems.notFound('run not found'));
  if (run.principal !== ctx.principal.userId && !hasCapability(ctx.principal.role, 'workspaces.manage') && !hasCapability(ctx.principal.role, 'audit.read')) {
    await requireRelation(ctx, 'member', fga.workspace(run.workspaceId));
  }
}

async function memberships(ctx: AuthedContext): Promise<string[]> {
  return (await ctx.db((db) => db.select({ id: schema.workspaceMembers.workspaceId }).from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, ctx.principal.userId)))).map((r) => r.id);
}

/** May the caller change memories about this subject? */
async function mayControl(ctx: AuthedContext, scope: Scope, subjectId: string): Promise<void> {
  if (scope === 'user') {
    if (subjectId !== ctx.principal.userId) throw new ProblemError(problems.forbidden('a person’s memories are theirs alone'));
  } else if (scope === 'workspace') {
    if (!hasCapability(ctx.principal.role, 'workspaces.manage')) await requireRelation(ctx, 'member', fga.workspace(subjectId));
  } else {
    requireCapability(ctx, 'knowledge.manage');
    if (subjectId !== ctx.principal.tenantId) throw new ProblemError(problems.forbidden('not this organization'));
  }
}

async function owned(ctx: AuthedContext, id: string) {
  const m = await svc(ctx).memory.get(ctx.principal.tenantId, id);
  if (!m) throw new ProblemError(problems.notFound('memory not found'));
  await mayControl(ctx, m.scope as Scope, m.subjectId);
  return m;
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof MemoryRejected) throw new ProblemError(problems.preconditionFailed(e.message));
    throw e;
  }
}

const Scope = z.enum(['user', 'workspace', 'tenant']);
const MemoryClass = z.enum(MEMORY_CLASSES);

export const memoriesRouter = router({
  /** Everything the caller may see: their own, their workspaces', the organization's (§8.1). */
  list: procedure.input(z.object({ scope: Scope.optional(), class: MemoryClass.optional(), includeInactive: z.boolean().optional() }).optional()).query(async ({ ctx, input }) => {
    const subjects = svc(ctx).subjectsFor({ tenantId: ctx.principal.tenantId, userId: ctx.principal.userId, workspaceIds: await memberships(ctx) }).filter((s) => !input?.scope || s.scope === input.scope);
    return svc(ctx).memory.list(ctx.principal.tenantId, { subjects, ...(input?.class ? { class: input.class } : {}), ...(input?.includeInactive ? { includeInactive: true } : {}) });
  }),
  /** A person telling the system something: TRUSTED by definition. */
  create: procedure.input(z.object({ scope: Scope.default('user'), workspaceId: Uuid.optional(), class: MemoryClass, content: z.string().trim().min(1).max(2000) })).mutation(async ({ ctx, input }) => {
    const subjectId = input.scope === 'user' ? ctx.principal.userId : input.scope === 'tenant' ? ctx.principal.tenantId : input.workspaceId;
    if (!subjectId) throw new ProblemError(problems.validation([{ path: 'workspaceId', message: 'a workspace memory needs workspaceId' }]));
    await mayControl(ctx, input.scope, subjectId);
    return wrap(() => svc(ctx).memory.propose(ctx.principal.tenantId, { scope: input.scope, subjectId, class: input.class, content: input.content, sourceTaint: 'TRUSTED', provenance: { via: 'user' }, createdBy: ctx.principal.userId, confidence: 0.9 }));
  }),
  update: procedure.input(z.object({ id: Uuid, content: z.string().trim().min(1).max(2000).optional(), pinned: z.boolean().optional(), stale: z.boolean().optional() })).mutation(async ({ ctx, input }) => {
    await owned(ctx, input.id);
    if (input.content !== undefined) await wrap(() => svc(ctx).memory.edit(ctx.principal.tenantId, input.id, input.content!, ctx.principal.userId));
    if (input.pinned !== undefined || input.stale !== undefined) await svc(ctx).memory.setFlags(ctx.principal.tenantId, input.id, { ...(input.pinned !== undefined ? { pinned: input.pinned } : {}), ...(input.stale !== undefined ? { stale: input.stale } : {}) });
    return svc(ctx).memory.get(ctx.principal.tenantId, input.id);
  }),
  delete: procedure.input(z.object({ id: Uuid })).mutation(async ({ ctx, input }) => {
    await owned(ctx, input.id);
    return { deleted: await svc(ctx).memory.delete(ctx.principal.tenantId, input.id, ctx.principal.userId) };
  }),
  conflicts: procedure.query(async ({ ctx }) => svc(ctx).memory.conflicts(ctx.principal.tenantId, svc(ctx).subjectsFor({ tenantId: ctx.principal.tenantId, userId: ctx.principal.userId, workspaceIds: await memberships(ctx) }))),
  resolve: procedure.input(z.object({ id: Uuid, resolution: z.enum(['keep_existing', 'accept_new', 'merge', 'both_valid']), mergedContent: z.string().trim().max(2000).optional() })).mutation(async ({ ctx, input }) => {
    const open = (await svc(ctx).memory.conflicts(ctx.principal.tenantId, svc(ctx).subjectsFor({ tenantId: ctx.principal.tenantId, userId: ctx.principal.userId, workspaceIds: await memberships(ctx) }))).find((c) => c.id === input.id);
    if (!open) throw new ProblemError(problems.notFound('no open conflict with that id'));
    await mayControl(ctx, open.proposed.scope, open.proposed.subjectId);
    return wrap(() => svc(ctx).memory.resolve(ctx.principal.tenantId, input.id, { resolution: input.resolution, ...(input.mergedContent ? { mergedContent: input.mergedContent } : {}), by: ctx.principal.userId }));
  }),
  /** Export on request (§6.4): the caller's own memories, with provenance and history. */
  export: procedure.query(async ({ ctx }) => svc(ctx).memory.export(ctx.principal.tenantId, [{ scope: 'user', subjectId: ctx.principal.userId }])),
});

const MAX_UPLOAD = 20 * 1024 * 1024;

export const kbRouter = router({
  documents: procedure.query(async ({ ctx }) => {
    requireCapability(ctx, 'knowledge.manage');
    return (await svc(ctx).kb.documents(ctx.principal.tenantId)).map(({ aclUsers: _a, ...d }) => d);
  }),
  upload: procedure
    .input(
      z.object({
        title: z.string().trim().min(1).max(500),
        mime: z.string().min(3).max(200),
        dataBase64: z.string().min(1).max(Math.ceil((MAX_UPLOAD * 4) / 3) + 4),
        workspaceId: Uuid.optional(),
        aclUsers: z.array(Uuid).max(500).optional(),
        sourceKind: z.enum(['upload', 'email_attachment', 'url']).default('upload'),
        externalRef: z.string().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx, 'knowledge.manage');
      const data = new Uint8Array(Buffer.from(input.dataBase64, 'base64'));
      if (data.length > MAX_UPLOAD) throw new ProblemError(problems.validation([{ path: 'dataBase64', message: 'documents are limited to 20 MB' }]));
      return svc(ctx).kb.ingest(ctx.principal.tenantId, { title: input.title, mime: input.mime, data, sourceKind: input.sourceKind, externalRef: input.externalRef ?? null, workspaceId: input.workspaceId ?? null, ...(input.aclUsers ? { aclUsers: input.aclUsers } : {}), createdBy: ctx.principal.userId });
    }),
  reindex: procedure.input(z.object({ id: Uuid })).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'knowledge.manage');
    return svc(ctx).kb.reindex(ctx.principal.tenantId, input.id);
  }),
  delete: procedure.input(z.object({ id: Uuid })).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'knowledge.manage');
    return { deleted: await svc(ctx).kb.delete(ctx.principal.tenantId, input.id) };
  }),
  /** "Who can retrieve this" (§8.2). */
  aclPreview: procedure.input(z.object({ id: Uuid })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'knowledge.manage');
    return svc(ctx).kb.aclPreview(ctx.principal.tenantId, input.id);
  }),
  /** ACL-gated as the CALLER: an inspection surface, never a way around permissions. */
  search: procedure.input(z.object({ query: z.string().trim().min(1).max(2000), k: z.number().int().min(1).max(20).default(5) })).mutation(async ({ ctx, input }) =>
    svc(ctx).kb.search(ctx.principal.tenantId, { userId: ctx.principal.userId, query: input.query, k: input.k, purpose: 'search' }),
  ),
});

export const verificationsRouter = router({
  /** Every verification of a run, in order, with its checks (§8.3). */
  forRun: procedure.input(z.object({ runId: Uuid })).query(async ({ ctx, input }) => {
    await readable(ctx, input.runId);
    const rows = await ctx.db((db) => db.select().from(schema.verifications).where(eq(schema.verifications.runId, input.runId)).orderBy(asc(schema.verifications.createdAt)));
    const findings = rows.length
      ? await ctx.db((db) => db.select({ verificationId: schema.groundednessFindings.verificationId, verdict: schema.groundednessFindings.verdict }).from(schema.groundednessFindings).where(inArray(schema.groundednessFindings.verificationId, rows.map((r) => r.id))))
      : [];
    return rows.map((r) => {
      const mine = findings.filter((f) => f.verificationId === r.id);
      return { ...r, claims: mine.length, unsupported: mine.filter((f) => f.verdict !== 'SUPPORTED').length };
    });
  }),
  get: procedure.input(z.object({ id: Uuid })).query(async ({ ctx, input }) => {
    const [v] = await ctx.db((db) => db.select().from(schema.verifications).where(eq(schema.verifications.id, input.id)));
    if (!v) throw new ProblemError(problems.notFound('verification not found'));
    await readable(ctx, v.runId);
    return v;
  }),
  /** Claim-level findings: what was said, whether a source supports it, and which. */
  groundedness: procedure.input(z.object({ id: Uuid })).query(async ({ ctx, input }) => {
    const [v] = await ctx.db((db) => db.select({ runId: schema.verifications.runId }).from(schema.verifications).where(eq(schema.verifications.id, input.id)));
    if (!v) throw new ProblemError(problems.notFound('verification not found'));
    await readable(ctx, v.runId);
    return ctx.db((db) => db.select().from(schema.groundednessFindings).where(eq(schema.groundednessFindings.verificationId, input.id)));
  }),
});

export const retrievalsRouter = router({
  /** The retrieval inspector (§8.4): what was retrieved, from where, and how much was withheld. */
  forRun: procedure.input(z.object({ runId: Uuid })).query(async ({ ctx, input }) => {
    await readable(ctx, input.runId);
    const rows = await ctx.db((db) => db.select().from(schema.retrievals).where(eq(schema.retrievals.runId, input.runId)).orderBy(desc(schema.retrievals.createdAt)));
    const chunkIds = [...new Set(rows.flatMap((r) => r.chunkIds))];
    const chunks = chunkIds.length
      ? await ctx.db((db) =>
          db
            .select({ id: schema.kbChunks.id, documentId: schema.kbChunks.documentId, headingPath: schema.kbChunks.headingPath, title: schema.kbDocuments.title, taint: schema.kbDocuments.taint })
            .from(schema.kbChunks)
            .innerJoin(schema.kbDocuments, eq(schema.kbDocuments.id, schema.kbChunks.documentId))
            .where(inArray(schema.kbChunks.id, chunkIds)),
        )
      : [];
    const memIds = [...new Set(rows.flatMap((r) => r.memoryIds))];
    const mems = memIds.length ? await ctx.db((db) => db.select({ id: schema.memories.id, class: schema.memories.class, content: schema.memories.content, taint: schema.memories.sourceTaint }).from(schema.memories).where(and(inArray(schema.memories.id, memIds)))) : [];
    const byChunk = new Map(chunks.map((c) => [c.id, c]));
    const byMem = new Map(mems.map((m) => [m.id, m]));
    return rows.map((r) => ({
      id: r.id,
      purpose: r.purpose,
      query: r.query,
      createdAt: r.createdAt,
      aclFiltered: r.aclFiltered,
      sensitivityFiltered: r.sensitivityFiltered,
      // A chunk or memory deleted since shows as removed: the log keeps references, not content.
      chunks: r.chunkIds.map((id) => ({ ...(byChunk.get(id) ?? { id, removed: true }), score: (r.scoresJson as Array<{ chunkId?: string; score?: number }>).find((s) => s.chunkId === id)?.score ?? null })),
      memories: r.memoryIds.map((id) => byMem.get(id) ?? { id, removed: true }),
    }));
  }),
});
