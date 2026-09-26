import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { safeEqual, type Logger } from '@vega/shared';
import type { EvidenceWriter } from '@vega/db/evidence';

/**
 * Evidence plane service — Module 1 stub (module1.md §5.1): `/append` and a separate DB
 * connection. Module 7 replaces the inbox with the signed hash chain; the SHAPE of this
 * boundary does not change: one inbound endpoint, append-only, no read path for callers.
 *
 * Caller authentication: in a cluster, mTLS between namespaces plus Cilium's rule that only
 * vega-execution may reach this port, and only `/append` (infra/k8s). The bearer token here
 * is the development stand-in; it is compared in constant time and is not a substitute for
 * either control.
 */

export const AppendRequest = z.object({
  tenantId: z.string().uuid(),
  source: z.string().min(1).max(64),
  kind: z.string().min(1).max(128),
  payload: z.record(z.string(), z.unknown()),
});

export interface EvidenceAppOptions {
  writer: EvidenceWriter;
  appendToken: string;
  logger: Logger;
}

export async function buildEvidenceApp(options: EvidenceAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    const ok = await options.writer.ping().catch(() => false);
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'not_ready' });
  });

  app.post('/append', async (req, reply) => {
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!presented || !safeEqual(presented, options.appendToken)) {
      return reply.code(401).type('application/problem+json').send({ type: 'about:blank', title: 'Unauthorized', status: 401 });
    }
    const parsed = AppendRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).type('application/problem+json').send({
        type: 'about:blank',
        title: 'Invalid evidence entry',
        status: 400,
        errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const receipt = await options.writer.append(parsed.data);
    return reply.code(201).send({ id: receipt.id, receivedAt: receipt.receivedAt.toISOString() });
  });

  // Deliberately no GET/PUT/PATCH/DELETE on entries. The evidence plane has no inbound read
  // path from the execution plane — not merely an unauthorized one.
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).type('application/problem+json').send({ type: 'about:blank', title: 'Not found', status: 404 }),
  );
  return app;
}
