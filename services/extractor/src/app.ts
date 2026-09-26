import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { ExtractRequest, type Extractor } from './extract.js';

export async function buildExtractorApp(options: { extractor: Extractor; token: string; https?: Record<string, unknown> }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, ...(options.https ? { https: options.https } : {}) }) as unknown as FastifyInstance;
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async () => ({ status: 'ready' }));

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz' || req.url === '/readyz') return;
    const header = req.headers.authorization ?? '';
    const presented = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    const expected = Buffer.from(options.token);
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'service token required' } });
    }
  });

  app.post('/extract', async (req, reply) => {
    const input = ExtractRequest.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: { code: 'VALIDATION', message: input.error.message } });
    if (!options.extractor.hasSchema(input.data.schema)) return reply.code(400).send({ error: { code: 'UNKNOWN_SCHEMA', message: input.data.schema } });
    try {
      const r = await options.extractor.extract(input.data.schema, input.data.content, input.data.purpose);
      // 422 carries the nonconforming output: the caller records it as a violation.
      return reply.code(r.ok ? 200 : 422).send({ data: r.data, ...(r.issues ? { issues: r.issues } : {}) });
    } catch {
      return reply.code(503).send({ error: { code: 'EXTRACTOR_UNAVAILABLE', message: 'model unavailable' } });
    }
  });
  return app;
}
