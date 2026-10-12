import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { hasCapability } from '@vega/authz';
import { evidenceTenantBySlug, schema } from '@vega/db';
import { problems } from '@vega/shared';
import { EvidenceUnavailable, type EvidenceClient } from '../evidence/client.js';
import { evidencePublicProcedure, procedure, ProblemError, requireCapability, requireExposed, router, type AuthedContext, type Context } from '../trpc.js';
import { readable } from './runs.js';

/**
 * Module 7 — the Evidence Plane's API (docs/module7.md §7), as the control plane serves it.
 * The control plane AUTHORIZES; the evidence plane answers. Every call here has passed:
 *
 *   capability   audit.read (the explorer, verification, replay) · evidence.export (packs)
 *                · audit.read_bodies (message bodies; an AUDITOR sees receipts, not bodies)
 *   exposure     packs and replay are Teams/Enterprise surfaces (§14.1); the chain is written for
 *                every plan regardless, and every plan reads its own run history (C8)
 *   relationship a run's trace: its principal, or whoever may read the run
 *
 * and the evidence plane then scopes the query to this tenant. Redaction and pack builds are
 * themselves chain entries (written by the evidence plane), so using these powers leaves evidence.
 */

function ev(ctx: Context): EvidenceClient {
  if (!ctx.deps.evidence) throw new ProblemError(problems.upstreamUnavailable('evidence plane'));
  return ctx.deps.evidence;
}

/** Calls the evidence plane, carrying its problem (status, detail) through as ours. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof EvidenceUnavailable) throw new ProblemError(e.problem);
    throw e;
  }
}

const bodies = (ctx: AuthedContext) => hasCapability(ctx.principal.role, 'audit.read_bodies');

export const Facets = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  kinds: z.array(z.string().max(64)).max(20).optional(),
  runId: z.string().max(100).optional(),
  actionId: z.string().max(100).optional(),
  actor: z.string().max(300).optional(),
  agentId: z.string().max(100).optional(),
  toolId: z.string().max(200).optional(),
  connectorId: z.string().max(100).optional(),
  riskTier: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  decision: z.string().max(40).optional(),
  subject: z.string().max(300).optional(),
});
export type Facets = z.infer<typeof Facets>;

const q = (f: Facets) => ({ ...f, kinds: f.kinds?.length ? f.kinds : undefined });

/** Pack templates (§6.3): the common questions, as queries. */
export const PACK_TEMPLATES = {
  client: { label: 'Everything about this client', needs: 'subject' as const, query: {} },
  external_comms_quarter: { label: 'All external communications this quarter', needs: null, query: { kinds: ['action.pre', 'action.post'] } },
  agent: { label: 'All actions by this agent', needs: 'agentId' as const, query: {} },
  critical: { label: 'All Critical-tier actions', needs: null, query: { riskTier: 'CRITICAL' as const } },
};

function quarterStart(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1)).toISOString();
}

async function tenantSlug(ctx: AuthedContext): Promise<string> {
  const [t] = await ctx.db((db) => db.select({ slug: schema.tenants.slug }).from(schema.tenants).where(eq(schema.tenants.id, ctx.principal.tenantId)));
  return t?.slug ?? ctx.principal.tenantId;
}

export const auditRouter = router({
  /** The Audit Explorer (§6.1): faceted, cursor-paginated, newest first. */
  entries: procedure.input(Facets.extend({ cursor: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(200).optional() })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'audit.read');
    const { cursor, limit, ...f } = input;
    return call(() => ev(ctx).json<{ items: unknown[]; nextCursor: number | null }>('GET', `/query/${ctx.principal.tenantId}/entries`, { query: { ...q(f), cursor, limit: limit ?? 50 } }));
  }),
  count: procedure.input(Facets).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'audit.read');
    return call(() => ev(ctx).json<{ count: number }>('GET', `/query/${ctx.principal.tenantId}/entries/count`, { query: q(input) }));
  }),
  entry: procedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'audit.read');
    return call(() => ev(ctx).json<Record<string, unknown>>('GET', `/query/${ctx.principal.tenantId}/entries/${input.id}`));
  }),
  /** The chain status widget (§6.1, §6.5): head, last anchor, entries since, last verification. */
  head: procedure.query(async ({ ctx }) => {
    requireCapability(ctx, 'audit.read');
    return call(() => ev(ctx).json<Record<string, unknown>>('GET', `/query/${ctx.principal.tenantId}/head`));
  }),
  verify: procedure.input(z.object({ full: z.boolean().optional() }).optional()).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'audit.read');
    return call(() => ev(ctx).json<Record<string, unknown>>('POST', `/query/${ctx.principal.tenantId}/verify`, { body: { full: input?.full ?? true } }));
  }),
  anchors: procedure.input(z.object({ limit: z.number().int().min(1).max(1000).optional() }).optional()).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'audit.read');
    return call(() => ev(ctx).json<{ items: unknown[] }>('GET', `/query/${ctx.principal.tenantId}/anchors`, { query: { limit: input?.limit ?? 100 } }));
  }),
  anchorNow: procedure.mutation(async ({ ctx }) => {
    requireCapability(ctx, 'evidence.export');
    return call(() => ev(ctx).json<Record<string, unknown>>('POST', `/query/${ctx.principal.tenantId}/anchors`));
  }),
  /** Content a receipt names, by digest (permission-gated, §6.1): bodies need audit.read_bodies. */
  content: procedure.input(z.object({ digest: z.string().regex(/^sha256:[0-9a-f]{64}$/) })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'audit.read');
    const r = await call(() => ev(ctx).bytes(`/query/${ctx.principal.tenantId}/content/${input.digest}${bodies(ctx) ? '?bodies=true' : ''}`));
    const text = /json|text/.test(r.contentType) ? r.bytes.toString('utf8') : null;
    return { digest: input.digest, mediaType: r.contentType, size: r.bytes.length, text, base64: text === null ? r.bytes.toString('base64') : null };
  }),
  /**
   * GDPR erasure (§5.5). Needs bodies access AND authority over the tenant's records (an owner,
   * an admin, or a compliance officer); the request id is mandatory and the redaction is itself a
   * chain entry — "redaction abuse" (§10) leaves evidence of itself.
   */
  redact: procedure.input(z.object({ digest: z.string().regex(/^sha256:[0-9a-f]{64}$/), requestId: z.string().min(3).max(200), reason: z.string().min(3).max(1000) })).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'audit.read_bodies');
    if (!hasCapability(ctx.principal.role, 'tenant.update') && !hasCapability(ctx.principal.role, 'evidence.export')) throw new ProblemError(problems.forbidden('redaction needs authority over the tenant’s records'));
    const out = await call(() => ev(ctx).json<Record<string, unknown>>('POST', `/query/${ctx.principal.tenantId}/redactions`, { body: { ...input, requestedBy: ctx.principal.userId } }));
    ctx.log.warn({ digest: input.digest, request_id: input.requestId }, 'content redacted (recorded in the chain)');
    return out;
  }),
});

export const tracesRouter = router({
  /** C8 (§5.9, §6.2): a run's six questions, from the chain. Every plan reads its own history. */
  get: procedure.input(z.object({ runId: z.string().uuid(), export: z.boolean().optional() })).query(async ({ ctx, input }) => {
    let own = false;
    if (!hasCapability(ctx.principal.role, 'audit.read')) {
      const run = await readable(ctx, input.runId);
      own = run.principalUserId === ctx.principal.userId;
    }
    return call(() => ev(ctx).json<Record<string, unknown>>('GET', `/query/${ctx.principal.tenantId}/runs/${input.runId}/trace`, { query: { bodies: bodies(ctx) || own ? 'true' : undefined, export: input.export ? 'true' : undefined } }));
  }),
});

export const evidencePacksRouter = router({
  templates: procedure.query(() => Object.entries(PACK_TEMPLATES).map(([id, t]) => ({ id, label: t.label, needs: t.needs }))),
  create: procedure
    .input(z.object({ query: Facets.default({}), template: z.enum(['client', 'external_comms_quarter', 'agent', 'critical']).optional(), includeBodies: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx, 'evidence.export');
      requireExposed(ctx, 'evidencePacks');
      let query: Facets = input.query;
      if (input.template) {
        const t = PACK_TEMPLATES[input.template];
        if (t.needs && !query[t.needs]) throw new ProblemError(problems.validation([{ path: `query.${t.needs}`, message: `the “${t.label}” template needs ${t.needs}` }]));
        query = { ...t.query, ...(input.template === 'external_comms_quarter' && !query.from ? { from: quarterStart() } : {}), ...query };
      }
      if (input.includeBodies && !bodies(ctx)) throw new ProblemError(problems.forbidden('including message bodies needs audit.read_bodies'));
      const slug = await tenantSlug(ctx);
      return call(() => ev(ctx).json<{ id: string; status: string }>('POST', `/query/${ctx.principal.tenantId}/packs`, { body: { tenantSlug: slug, requestedBy: ctx.principal.userId, includeBodies: input.includeBodies ?? false, query: q(query) } }));
    }),
  get: procedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'evidence.export');
    const p = await call(() => ev(ctx).json<Record<string, unknown>>('GET', `/query/${ctx.principal.tenantId}/packs/${input.id}`));
    return { ...p, downloadUrl: p['status'] === 'built' ? `/v1/evidence-packs/${input.id}/download` : null };
  }),
  /** The archive (§8.2: an expiring link — the evidence plane refuses after `expiresAt`). */
  download: procedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'evidence.export');
    requireExposed(ctx, 'evidencePacks');
    const r = await call(() => ev(ctx).bytes(`/query/${ctx.principal.tenantId}/packs/${input.id}/download`));
    ctx.log.info({ pack_id: input.id, bytes: r.bytes.length }, 'evidence pack downloaded');
    return { filename: r.filename ?? `evidence-pack-${input.id}.zip`, contentType: r.contentType, base64: r.bytes.toString('base64') };
  }),
  list: procedure.input(z.object({ limit: z.number().int().min(1).max(100).optional() }).optional()).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'evidence.export');
    return call(() => ev(ctx).json<{ items: unknown[] }>('GET', `/query/${ctx.principal.tenantId}/packs`, { query: { limit: input?.limit ?? 20 } }));
  }),
});

export const replayRouter = router({
  /** §5.7: re-run a recorded decision in DRY mode. Teams/Enterprise (§14.1). */
  run: procedure.input(z.object({ actionId: z.string().min(1).max(100) })).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'audit.read');
    requireExposed(ctx, 'deterministicReplay');
    return call(() => ev(ctx).json<Record<string, unknown>>('POST', `/query/${ctx.principal.tenantId}/replay/${encodeURIComponent(input.actionId)}`, { body: { requestedBy: ctx.principal.userId } }));
  }),
  get: procedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'audit.read');
    requireExposed(ctx, 'deterministicReplay');
    return call(() => ev(ctx).json<Record<string, unknown>>('GET', `/query/${ctx.principal.tenantId}/replay/${input.id}`));
  }),
  forAction: procedure.input(z.object({ actionId: z.string().min(1).max(100) })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'audit.read');
    requireExposed(ctx, 'deterministicReplay');
    return call(() => ev(ctx).json<{ items: unknown[] }>('GET', `/query/${ctx.principal.tenantId}/actions/${encodeURIComponent(input.actionId)}/replays`));
  }),
});

/**
 * PUBLIC (§7): `/.well-known/vega/keys` and `/.well-known/vega/anchors/<tenant>` — what lets an
 * auditor confirm an anchor without an account. Reached only through the gateway's
 * unauthenticated routes, as the `evidence_public` system principal.
 */
export const publicEvidenceRouter = router({
  keys: evidencePublicProcedure.query(async ({ ctx }) => call(() => ev(ctx).json<{ keys: unknown[] }>('GET', '/public/keys'))),
  anchors: evidencePublicProcedure.input(z.object({ slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/) })).query(async ({ ctx, input }) => {
    const tenantId = await evidenceTenantBySlug(input.slug);
    if (!tenantId) throw new ProblemError(problems.notFound('no such tenant'));
    const out = await call(() => ev(ctx).json<{ tenantId: string; anchors: unknown[] }>('GET', `/public/anchors/${tenantId}`));
    return { tenant: input.slug, ...out };
  }),
});


