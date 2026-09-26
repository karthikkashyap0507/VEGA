import Fastify, { type FastifyInstance } from 'fastify';
import type { EvidenceAppendClient } from './evidence-append.js';

/**
 * Execution plane — Module 1 stub: health endpoints and plane wiring only (module1.md §5.1).
 * Module 3 adds the capability interpreter, Module 4 the orchestrator and connector runtime.
 *
 * The one piece of wiring that is real from M1: `/readyz` proves the evidence append path is
 * configured, because from M4 on "no side effect occurs before its audit entry is committed"
 * (invariant 2) and an execution plane that cannot append must not report ready.
 */
export async function buildExecutionApp(options: {
  evidence?: EvidenceAppendClient;
  https?: Record<string, unknown>;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, ...(options.https ? { https: options.https } : {}) }) as unknown as FastifyInstance;
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    const ready = Boolean(options.evidence);
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'evidence_append_unconfigured' });
  });
  return app;
}
