import Fastify, { type FastifyInstance } from 'fastify';
import type { EvidenceAppendClient } from './evidence-append.js';
import { registerConnectorApi, type ConnectorApiDeps } from './connectors.js';
import { registerProgramApi, type ProgramApiDeps } from './programs.js';

/**
 * Execution plane (module1.md §5.1). Module 2 adds the connector runtime behind an internal
 * API (connectors.ts); Module 3 the capability interpreter; Module 4 the orchestrator.
 *
 * The one piece of wiring that is real from M1: `/readyz` proves the evidence append path is
 * configured, because from M4 on "no side effect occurs before its audit entry is committed"
 * (invariant 2) and an execution plane that cannot append must not report ready.
 */
export async function buildExecutionApp(options: {
  evidence?: EvidenceAppendClient;
  connectors?: ConnectorApiDeps;
  /** Module 3: the capability interpreter. Mounted behind the same service token. */
  programs?: ProgramApiDeps;
  https?: Record<string, unknown>;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, ...(options.https ? { https: options.https } : {}) }) as unknown as FastifyInstance;
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    const ready = Boolean(options.evidence);
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'evidence_append_unconfigured' });
  });
  if (options.connectors) registerConnectorApi(app, options.connectors);
  if (options.connectors && options.programs) registerProgramApi(app, options.programs);
  return app;
}
