import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Uuid } from '@vega/contracts';
import { SYSTEM_TENANT } from '@vega/idp';
import type { GatewayDeps } from '../app.js';
import { defineRoute, type RouteHooks } from '../http.js';

/**
 * The Evidence Plane — docs/module7.md §7. Reads, packs, replay and traces for signed-in people
 * the control plane authorizes; plus the two PUBLIC endpoints that let an auditor confirm keys
 * and anchors without an account. (`POST /v1/audit/append` is the execution plane's, internal,
 * and never reaches this gateway: the evidence service is not routable from here.)
 */
export function registerEvidenceRoutes(app: FastifyInstance, hooks: RouteHooks, deps: GatewayDeps): void {
  const tags = ['evidence'];
  const Id = z.object({ id: Uuid });
  const csv = z.string().max(500).transform((s) => s.split(',').filter(Boolean));
  const Facets = z.object({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    kinds: csv.optional(),
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
  const FacetsBody = Facets.extend({ kinds: z.array(z.string().max(64)).max(20).optional() });

  // ------------------------------------------------------------ the chain
  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/audit/entries',
    summary: 'The chain, faceted and cursor-paginated (newest first)',
    tags,
    query: Facets.extend({ cursor: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }),
    handler: ({ control, query }) => control.audit.entries.query(query),
  });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/audit/entries/count', summary: 'How many entries a query matches (the pack builder’s live count)', tags, query: Facets, handler: ({ control, query }) => control.audit.count.query(query) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/audit/entries/:id', summary: 'One entry: the full receipt, its hashes and signature', tags, params: Id, handler: ({ control, params }) => control.audit.entry.query(params) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/audit/head', summary: 'Chain head, last anchor, entries since, last verification', tags, handler: ({ control }) => control.audit.head.query() });
  defineRoute(app, hooks, { method: 'POST', url: '/v1/audit/verify', summary: 'Server-side integrity check of the whole chain', tags, body: z.object({ full: z.boolean().optional() }).optional(), successStatus: 200, handler: ({ control, body }) => control.audit.verify.mutate(body ?? {}) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/audit/anchors', summary: 'Signed tree heads (anchors)', tags, query: z.object({ limit: z.coerce.number().int().min(1).max(1000).optional() }), handler: ({ control, query }) => control.audit.anchors.query(query) });
  defineRoute(app, hooks, { method: 'POST', url: '/v1/audit/anchors', summary: 'Anchor the chain now (on demand)', tags, handler: ({ control }) => control.audit.anchorNow.mutate() });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/audit/content/:digest', summary: 'Content a receipt names, by digest (bodies need audit.read_bodies)', tags, params: z.object({ digest: z.string().regex(/^sha256:[0-9a-f]{64}$/) }), handler: ({ control, params }) => control.audit.content.query(params) });
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/audit/redactions',
    summary: 'Erase content under a recorded request (GDPR); the digest and the chain remain',
    tags,
    body: z.object({ digest: z.string().regex(/^sha256:[0-9a-f]{64}$/), requestId: z.string().min(3).max(200), reason: z.string().min(3).max(1000) }),
    handler: ({ control, body }) => control.audit.redact.mutate(body),
  });

  // ------------------------------------------------------------ evidence packs
  defineRoute(app, hooks, { method: 'GET', url: '/v1/evidence-packs/templates', summary: 'Common pack queries', tags, handler: ({ control }) => control.evidencePacks.templates.query() });
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/evidence-packs',
    summary: 'Build a signed evidence pack from a query (a job)',
    tags,
    body: z.object({ query: FacetsBody.optional(), template: z.enum(['client', 'external_comms_quarter', 'agent', 'critical']).optional(), includeBodies: z.boolean().optional() }),
    successStatus: 202,
    handler: ({ control, body }) => control.evidencePacks.create.mutate({ query: body.query ?? {}, ...(body.template ? { template: body.template } : {}), ...(body.includeBodies !== undefined ? { includeBodies: body.includeBodies } : {}) }),
  });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/evidence-packs', summary: 'Pack history', tags, query: z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }), handler: ({ control, query }) => control.evidencePacks.list.query(query) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/evidence-packs/:id', summary: 'Build status and the download link', tags, params: Id, handler: ({ control, params }) => control.evidencePacks.get.query(params) });
  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/evidence-packs/:id/download',
    summary: 'The pack archive (zip), verifiable offline with the verifier inside it',
    tags,
    params: Id,
    handler: async ({ control, params, reply }) => {
      const r = await control.evidencePacks.download.query(params);
      return reply.code(200).type('application/zip').header('content-disposition', `attachment; filename="${r.filename.replace(/[^\w.-]/g, '_')}"`).header('cache-control', 'no-store').send(Buffer.from(r.base64, 'base64'));
    },
  });

  // ------------------------------------------------------------ replay and traces
  defineRoute(app, hooks, { method: 'POST', url: '/v1/replay/:actionId', summary: 'Deterministic replay of a recorded action (DRY: nothing is called)', tags, params: z.object({ actionId: z.string().min(1).max(100) }), handler: ({ control, params }) => control.replay.run.mutate(params) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/replay/:id', summary: 'A replay and its layer-by-layer comparison', tags, params: Id, handler: ({ control, params }) => control.replay.get.query(params) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/actions/:actionId/replays', summary: 'Replays of one action', tags, params: z.object({ actionId: z.string().min(1).max(100) }), handler: ({ control, params }) => control.replay.forAction.query(params) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/runs/:id/trace', summary: 'C8: what the run did, why, with which tools and inputs, under which policies, with whose approval', tags, params: Id, handler: ({ control, params }) => control.traces.get.query({ runId: params.id }) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/runs/:id/trace/export', summary: 'The trace with the chain entries it was read from (machine-readable)', tags, params: Id, handler: ({ control, params }) => control.traces.get.query({ runId: params.id, export: true }) });

  // ------------------------------------------------------------ public (no account)
  const publicControl = () => deps.controlFor({ tenantId: SYSTEM_TENANT, userId: 'system:evidence_public', system: 'evidence_public' });
  defineRoute(app, hooks, {
    method: 'GET',
    url: '/.well-known/vega/keys',
    summary: 'Every evidence signing key, current and rotated (ML-DSA-65)',
    tags,
    auth: false,
    handler: async ({ reply }) => {
      reply.header('cache-control', 'public, max-age=300');
      return publicControl().publicEvidence.keys.query();
    },
  });
  defineRoute(app, hooks, {
    method: 'GET',
    url: '/.well-known/vega/anchors/:tenant',
    summary: 'A tenant’s published chain heads (signed tree heads)',
    tags,
    auth: false,
    params: z.object({ tenant: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/) }),
    handler: async ({ params, reply }) => {
      reply.header('cache-control', 'public, max-age=60');
      return publicControl().publicEvidence.anchors.query({ slug: params.tenant });
    },
  });
}
