import type { FastifyInstance } from 'fastify';
import type { JSONWebKeySet } from 'jose';
import type { Registry } from 'prom-client';

/** Health, readiness, metrics, and published verification keys (module1.md §7.1). */
export function registerSystemRoutes(
  app: FastifyInstance,
  deps: { registry: Registry; jwks: JSONWebKeySet; ready?: () => Promise<boolean> },
): void {
  app.get('/healthz', { schema: { hide: true } }, async () => ({ status: 'ok' }));
  app.get('/readyz', { schema: { hide: true } }, async (_req, reply) => {
    const ok = deps.ready ? await deps.ready().catch(() => false) : true;
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'not_ready' });
  });
  app.get('/metrics', { schema: { hide: true } }, async (_req, reply) =>
    reply.type(deps.registry.contentType).send(await deps.registry.metrics()),
  );
  /**
   * Public halves of the keys this gateway signs with. The control plane verifies principal
   * assertions against these; from Module 4 the execution plane verifies run tokens here.
   */
  app.get('/.well-known/jwks.json', { schema: { hide: true } }, async () => deps.jwks);
  app.get('/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());
}
