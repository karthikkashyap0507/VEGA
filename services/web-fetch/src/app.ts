import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ToolError } from '@vega/connector-sdk';
import { inProcessBackend, type SafeFetchOptions, type WebBackend } from '@vega/connector-web';

/**
 * Isolated web fetcher — docs/module2.md §10.3. The one workload with public egress, because
 * it ingests arbitrary attacker-controlled content:
 *
 *   · no service-account token, no database, no connector secret — nothing worth stealing
 *   · reachable only from the execution plane (Cilium), over mTLS
 *   · egress to the public internet on 80/443 EXCEPT private, link-local and loopback ranges —
 *     enforced by the network, independently of the checks safeFetch runs in this process
 *   · output is text with active content stripped; the caller labels it UNTRUSTED
 */

export interface WebFetchAppOptions {
  backend?: WebBackend;
  https?: Record<string, unknown>;
  /** Tests only. */
  fetchOptions?: SafeFetchOptions;
}

const FetchBody = z.object({ url: z.string().url().max(2048), maxBytes: z.number().int().min(1).max(5_000_000).default(1_000_000) });
const SearchBody = z.object({ query: z.string().min(1).max(400), max: z.number().int().min(1).max(20).default(8) });

export async function buildWebFetchApp(options: WebFetchAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, ...(options.https ? { https: options.https } : {}) }) as unknown as FastifyInstance;
  const backend = options.backend ?? inProcessBackend();

  const fail = (error: unknown) => {
    if (error instanceof ToolError) {
      const status = error.code === 'EGRESS_DENIED' ? 403 : error.code === 'VALIDATION' ? 422 : 502;
      return { status, body: { error: { code: error.code, message: error.message } } };
    }
    return { status: 502, body: { error: { code: 'TRANSIENT', message: 'fetch failed' } } };
  };

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async () => ({ status: 'ready' }));

  app.post('/fetch', async (req, reply) => {
    const input = FetchBody.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: { code: 'VALIDATION', message: input.error.message } });
    try {
      return await backend.fetch(input.data.url, input.data.maxBytes);
    } catch (error) {
      const f = fail(error);
      return reply.code(f.status).send(f.body);
    }
  });

  app.post('/search', async (req, reply) => {
    const input = SearchBody.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: { code: 'VALIDATION', message: input.error.message } });
    try {
      return { results: await backend.search(input.data.query, input.data.max) };
    } catch (error) {
      const f = fail(error);
      return reply.code(f.status).send(f.body);
    }
  });

  return app;
}
