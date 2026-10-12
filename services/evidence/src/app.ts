import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { safeEqual, type Logger } from '@vega/shared';
import type { EvidenceReader, EvidenceWriter } from '@vega/db/evidence';
import { toTreeHead, type Anchorer } from './anchor.js';
import { ChainService } from './chain/service.js';
import type { KeyCustody } from './chain/keys.js';
import type { ContentStore } from './content.js';
import { ContentRedacted } from './content.js';
import type { PackBuilder } from './packs/builder.js';
import type { ReplayEngine } from './replay.js';
import type { TraceBuilder } from './trace.js';
import type { ChainVerifier } from './verify.js';

/**
 * THE EVIDENCE PLANE SERVICE (module7.md §3, §7). Two doors, two credentials:
 *
 *   POST /append            the execution plane (and the control plane, for its own events).
 *                           One inbound endpoint, append-only. INVARIANT 1: a caller holding the
 *                           append credential can add an entry and do NOTHING else — there is no
 *                           read, update or delete route that credential opens.
 *
 *   /query/:tenant/...      the control plane, with a SEPARATE query credential, on behalf of a
 *                           person it has already authorized (audit.read, evidence.export,
 *                           audit.read_bodies, the plan's exposure). Reads, packs, replay,
 *                           verification, redaction.
 *
 *   /public/...             published keys and anchors (served to the world through the gateway).
 *
 * Caller authentication: in a cluster, mTLS between namespaces plus Cilium's rules — execution
 * may reach only POST /append, control only /query and /public (infra/helm). The bearer tokens
 * here are compared in constant time and are not a substitute for either control.
 */

const Content = z.object({
  data: z.string().max(12 * 1024 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/, 'base64'),
  mediaType: z.string().max(100).optional(),
  sensitivity: z.enum(['body', 'metadata']).optional(),
});

export const AppendRequest = z.object({
  tenantId: z.string().uuid(),
  source: z.string().min(1).max(64),
  kind: z.string().min(1).max(128).regex(/^[a-z][a-z0-9_.-]*$/, 'kind'),
  payload: z.record(z.string(), z.unknown()),
  content: z.array(Content).max(500).optional(),
});

export interface EvidenceAppOptions {
  writer: EvidenceWriter;
  /** The execution plane's credential: /append only. */
  appendToken: string;
  /** The control plane's append credential (its own events, e.g. policy.activated). */
  controlAppendToken?: string | undefined;
  /** The control plane's query credential. Without it (and a reader), /query does not exist. */
  queryToken?: string | undefined;
  logger: Logger;
  https?: Record<string, unknown>;
  custody?: KeyCustody;
  reader?: EvidenceReader;
  content?: ContentStore;
  chain?: ChainService;
  anchorer?: Anchorer;
  packs?: PackBuilder;
  replay?: ReplayEngine;
  trace?: TraceBuilder;
  verifier?: ChainVerifier;
  /**
   * Which doors this listener opens (default both). Deployed, each door is its own listener on its
   * own port — 3004 append, 3008 query — so network policy, not just a token, keeps the execution
   * plane on the append port (infra/helm network-policies).
   */
  doors?: { append?: boolean; query?: boolean };
}

const problem = (reply: FastifyReply, status: number, title: string, extra: Record<string, unknown> = {}) =>
  reply.code(status).type('application/problem+json').send({ type: 'about:blank', title, status, ...extra });

/** A JSON value Postgres jsonb can hold: no NUL in any string, no non-finite number. */
function storable(v: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (typeof v === 'string') return !v.includes('\u0000');
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => storable(x, depth + 1));
  if (v && typeof v === 'object') return Object.entries(v).every(([k, x]) => !k.includes('\u0000') && storable(x, depth + 1));
  return true;
}

const Facets = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  kinds: z.union([z.string(), z.array(z.string())]).optional().transform((v) => (v === undefined ? undefined : (Array.isArray(v) ? v : v.split(',')).filter(Boolean))),
  runId: z.string().max(100).optional(),
  actionId: z.string().max(100).optional(),
  actor: z.string().max(300).optional(),
  agentId: z.string().max(100).optional(),
  toolId: z.string().max(200).optional(),
  connectorId: z.string().max(100).optional(),
  riskTier: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  decision: z.string().max(40).optional(),
  subject: z.string().max(300).optional().transform((s) => s?.toLowerCase()),
});

export async function buildEvidenceApp(options: EvidenceAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 32 * 1024 * 1024,
    ...(options.https ? { https: options.https } : {}),
  }) as unknown as FastifyInstance;

  const chain = options.chain ?? (options.custody ? new ChainService({ writer: options.writer, reader: options.reader, custody: options.custody, content: options.content }) : undefined);

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    const ok = await options.writer.ping().catch(() => false);
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'not_ready' });
  });

  const bearer = (req: FastifyRequest) => {
    const h = req.headers.authorization ?? '';
    return h.startsWith('Bearer ') ? h.slice(7) : '';
  };

  // ------------------------------------------------------------------ the append door
  if (options.doors?.append !== false) app.post('/append', async (req, reply) => {
    const presented = bearer(req);
    const source = presented && safeEqual(presented, options.appendToken) ? 'execution' : presented && options.controlAppendToken && safeEqual(presented, options.controlAppendToken) ? 'control' : null;
    if (!source) return problem(reply, 401, 'Unauthorized');
    const parsed = AppendRequest.safeParse(req.body);
    if (!parsed.success) return problem(reply, 400, 'Invalid evidence entry', { errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    if (!storable(parsed.data.payload)) return problem(reply, 400, 'Invalid evidence entry', { errors: [{ path: 'payload', message: 'NUL characters and non-finite numbers cannot be recorded' }] });
    if (!chain) {
      // Module 1 shape: no signing key configured → the unsigned inbox (development only).
      const receipt = await options.writer.append({ ...parsed.data, source });
      return reply.code(201).send({ id: receipt.id, receivedAt: receipt.receivedAt.toISOString() });
    }
    // The source is the credential's, never the caller's claim.
    const r = await chain.append({ ...parsed.data, source });
    return reply.code(201).send({ id: r.id, seq: r.seq, entryHash: r.entryHash, receivedAt: r.ts, contentDigests: r.contentDigests });
  });

  // ------------------------------------------------------------------ the query door (control plane)
  const { reader, content, anchorer, packs, replay, trace, verifier } = options;
  if (options.doors?.query !== false && options.queryToken && reader && chain) {
    const token = options.queryToken;
    app.register(
      async (q) => {
        q.addHook('onRequest', async (req, reply) => {
          const presented = bearer(req);
          if (!presented || !safeEqual(presented, token)) return problem(reply, 401, 'Unauthorized');
        });
        const T = z.object({ tenant: z.string().uuid() });
        const parse = <S extends z.ZodTypeAny>(s: S, v: unknown, reply: FastifyReply): z.infer<S> | undefined => {
          const r = s.safeParse(v);
          if (!r.success) {
            void problem(reply, 400, 'Invalid request', { errors: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
            return undefined;
          }
          return r.data;
        };
        const entryView = (e: Awaited<ReturnType<typeof reader.entry>>) => e && { ...e, facets: e.facets };

        q.get('/query/:tenant/entries', async (req, reply) => {
          const p = parse(T, req.params, reply);
          const f = parse(Facets.extend({ cursor: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }), req.query, reply);
          if (!p || !f) return;
          const { cursor, limit = 50, ...facets } = f;
          const rows = await reader.entries({ tenantId: p.tenant, ...facets }, { limit: limit + 1, before: cursor });
          const more = rows.length > limit;
          const items = rows.slice(0, limit);
          return { items, nextCursor: more ? items.at(-1)!.seq : null };
        });
        q.get('/query/:tenant/entries/count', async (req, reply) => {
          const p = parse(T, req.params, reply);
          const f = parse(Facets, req.query, reply);
          if (!p || !f) return;
          return { count: await reader.count({ tenantId: p.tenant, ...f }) };
        });
        q.get('/query/:tenant/entries/:id', async (req, reply) => {
          const p = parse(T.extend({ id: z.string().uuid() }), req.params, reply);
          if (!p) return;
          const e = await reader.entry(p.tenant, p.id);
          return e ? entryView(e) : problem(reply, 404, 'No such entry');
        });
        q.get('/query/:tenant/head', async (req, reply) => {
          const p = parse(T, req.params, reply);
          if (!p) return;
          const [head, [anchor], verification] = await Promise.all([reader.head(p.tenant), reader.anchors(p.tenant, { limit: 1 }), reader.lastVerification(p.tenant)]);
          return {
            head,
            lastAnchor: anchor ? toTreeHead(anchor) : null,
            entriesSinceAnchor: head ? head.seq - (anchor?.treeSize ?? 0) : 0,
            verification: verification ? { ok: verification.ok, checkedAt: verification.checkedAt, entries: verification.entries, headSeq: verification.headSeq, failures: (verification.detail['failures'] as unknown[] | undefined)?.length ?? 0 } : null,
          };
        });
        q.post('/query/:tenant/verify', async (req, reply) => {
          const p = parse(T, req.params, reply);
          const b = parse(z.object({ full: z.boolean().optional() }).default({}), req.body ?? {}, reply);
          if (!p || !b) return;
          if (!verifier) return problem(reply, 503, 'Verification is not configured');
          return verifier.verify(p.tenant, { full: b.full ?? true });
        });
        q.get('/query/:tenant/anchors', async (req, reply) => {
          const p = parse(T, req.params, reply);
          const f = parse(z.object({ limit: z.coerce.number().int().min(1).max(1000).optional() }), req.query, reply);
          if (!p || !f) return;
          return { items: (await reader.anchors(p.tenant, { limit: f.limit ?? 100 })).map((a) => ({ ...toTreeHead(a), timestampToken: a.timestampToken })) };
        });
        q.post('/query/:tenant/anchors', async (req, reply) => {
          const p = parse(T, req.params, reply);
          if (!p) return;
          if (!anchorer) return problem(reply, 503, 'Anchoring is not configured');
          const head = await anchorer.anchor(p.tenant);
          return head ? reply.code(201).send(head) : problem(reply, 409, 'This tenant has no chain to anchor yet');
        });

        // -------------------------------------------------------- content and redaction
        q.get('/query/:tenant/content/:digest', async (req, reply) => {
          const p = parse(T.extend({ digest: z.string().regex(/^sha256:[0-9a-f]{64}$/) }), req.params, reply);
          const f = parse(z.object({ bodies: z.enum(['true', 'false']).optional() }), req.query, reply);
          if (!p || !f) return;
          if (!content) return problem(reply, 503, 'No content store');
          const meta = await content.meta(p.tenant, p.digest);
          if (!meta) return problem(reply, 404, 'No such content');
          if (meta.sensitivity === 'body' && f.bodies !== 'true') return problem(reply, 403, 'Reading message bodies needs audit.read_bodies');
          try {
            const bytes = await content.get(p.tenant, p.digest);
            return bytes ? reply.type(meta.mediaType).send(bytes) : problem(reply, 404, 'No such content');
          } catch (e) {
            if (e instanceof ContentRedacted) return problem(reply, 410, 'Content redacted', { redaction: e.redaction });
            throw e;
          }
        });
        q.post('/query/:tenant/redactions', async (req, reply) => {
          const p = parse(T, req.params, reply);
          const b = parse(z.object({ digest: z.string().regex(/^sha256:[0-9a-f]{64}$/), requestId: z.string().min(3).max(200), reason: z.string().min(3).max(1000), requestedBy: z.string().min(1).max(200) }), req.body, reply);
          if (!p || !b) return;
          if (!content) return problem(reply, 503, 'No content store');
          if (!(await content.meta(p.tenant, b.digest))) return problem(reply, 404, 'No such content');
          const r = await content.redact(p.tenant, b, (payload) => chain.append({ tenantId: p.tenant, source: 'evidence', kind: 'redaction', payload }));
          return reply.code(201).send(r);
        });

        // -------------------------------------------------------- packs
        const PackRequest = z.object({ tenantSlug: z.string().min(1).max(100), requestedBy: z.string().min(1).max(200), includeBodies: z.boolean().default(false), query: Facets });
        q.post('/query/:tenant/packs', async (req, reply) => {
          const p = parse(T, req.params, reply);
          const b = parse(PackRequest, req.body, reply);
          if (!p || !b) return;
          if (!packs) return problem(reply, 503, 'Evidence packs are not configured');
          const id = await packs.request({ tenantId: p.tenant, tenantSlug: b.tenantSlug, query: b.query, requestedBy: b.requestedBy, includeBodies: b.includeBodies });
          return reply.code(202).send({ id, status: 'building' });
        });
        q.get('/query/:tenant/packs', async (req, reply) => {
          const p = parse(T, req.params, reply);
          const f = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), before: z.string().datetime().optional() }), req.query, reply);
          if (!p || !f) return;
          if (!packs) return problem(reply, 503, 'Evidence packs are not configured');
          const rows = await reader.packs(p.tenant, { limit: f.limit ?? 20, before: f.before });
          return { items: rows.map((r) => packs.status(r)) };
        });
        q.get('/query/:tenant/packs/:id', async (req, reply) => {
          const p = parse(T.extend({ id: z.string().uuid() }), req.params, reply);
          if (!p) return;
          if (!packs) return problem(reply, 503, 'Evidence packs are not configured');
          const row = await reader.pack(p.tenant, p.id);
          return row ? packs.status(row) : problem(reply, 404, 'No such pack');
        });
        q.get('/query/:tenant/packs/:id/download', async (req, reply) => {
          const p = parse(T.extend({ id: z.string().uuid() }), req.params, reply);
          if (!p) return;
          if (!packs) return problem(reply, 503, 'Evidence packs are not configured');
          const row = await reader.pack(p.tenant, p.id);
          if (!row) return problem(reply, 404, 'No such pack');
          const bytes = await packs.download(row);
          if (!bytes) return problem(reply, 410, 'This pack is not available for download (still building, failed, or its link expired)');
          return reply.type('application/zip').header('content-disposition', `attachment; filename="evidence-pack-${row.id}.zip"`).send(bytes);
        });

        // -------------------------------------------------------- replay and trace
        q.post('/query/:tenant/replay/:actionId', async (req, reply) => {
          const p = parse(T.extend({ actionId: z.string().min(1).max(100) }), req.params, reply);
          const b = parse(z.object({ requestedBy: z.string().min(1).max(200) }), req.body, reply);
          if (!p || !b) return;
          if (!replay) return problem(reply, 503, 'Replay is not configured');
          const r = await replay.replay(p.tenant, p.actionId, b.requestedBy);
          return r ? reply.code(201).send(r) : problem(reply, 404, 'No receipt for that action');
        });
        q.get('/query/:tenant/replay/:id', async (req, reply) => {
          const p = parse(T.extend({ id: z.string().uuid() }), req.params, reply);
          if (!p) return;
          const r = await reader.replay(p.tenant, p.id);
          return r ?? problem(reply, 404, 'No such replay');
        });
        q.get('/query/:tenant/actions/:actionId/replays', async (req, reply) => {
          const p = parse(T.extend({ actionId: z.string().min(1).max(100) }), req.params, reply);
          if (!p) return;
          return { items: await reader.replays(p.tenant, p.actionId) };
        });
        q.get('/query/:tenant/runs/:runId/trace', async (req, reply) => {
          const p = parse(T.extend({ runId: z.string().min(1).max(100) }), req.params, reply);
          const f = parse(z.object({ bodies: z.enum(['true', 'false']).optional(), export: z.enum(['true', 'false']).optional() }), req.query, reply);
          if (!p || !f) return;
          if (!trace) return problem(reply, 503, 'Traces are not configured');
          const t = await trace.build(p.tenant, p.runId, { bodies: f.bodies === 'true' });
          if (!t) return problem(reply, 404, 'No evidence for that run');
          if (f.export !== 'true') return t;
          return { format: 'vega-run-trace/1', trace: t, entries: await trace.entries(p.tenant, p.runId), keys: await chain.publicKeys() };
        });

        // -------------------------------------------------------- published (the gateway serves these to anyone)
        // Behind the query credential all the same: the control plane publishes them, and the
        // append credential opens nothing but /append — not even public data.
        q.get('/public/keys', async () => ({ keys: await chain.publicKeys() }));
        q.get('/public/anchors/:tenant', async (req, reply) => {
          const p = parse(T, req.params, reply);
          if (!p) return;
          return { tenantId: p.tenant, anchors: (await reader.anchors(p.tenant, { limit: 1000 })).map(toTreeHead) };
        });
      },
    );
  }

  // Deliberately no GET/PUT/PATCH/DELETE for the append credential. The evidence plane has no
  // inbound read path from the execution plane — not merely an unauthorized one.
  app.setNotFoundHandler((_req, reply) => problem(reply, 404, 'Not found'));
  return app;
}
