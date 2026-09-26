import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { TRPCError } from '@trpc/server';
import { PrincipalAssertionError, type PrincipalAssertionVerifier, type PrincipalClaims } from '@vega/idp';
import { context, propagation, trace, type Span } from '@vega/telemetry';
import { appRouter, type AppRouter } from './routers/index.js';
import type { Context, ControlDeps } from './trpc.js';

/** Header carrying the gateway-signed principal assertion. A signed token, not a claim. */
export const PRINCIPAL_HEADER = 'x-principal-assertion';

export interface ControlAppOptions {
  deps: ControlDeps;
  verifier: PrincipalAssertionVerifier;
  /** mTLS server options (packages/shared internalServerTls). Absent: plain HTTP, dev only. */
  https?: Record<string, unknown>;
}

/**
 * The control-plane HTTP surface: tRPC at /trpc plus health endpoints.
 *
 * Reached only from the gateway (Cilium allows experience→control and nothing else inbound;
 * infra/k8s). Even so, nothing here trusts the network: every request carries a principal
 * assertion that is verified against the gateway's public key before any procedure runs.
 */
export async function buildControlApp(options: ControlAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    ...(options.https ? { https: options.https } : {}),
  }) as unknown as FastifyInstance;

  // Continue the gateway's trace: the span for this procedure is a child of the gateway span
  // named in `traceparent`, so one trace covers browser → gateway → control (module1.md §12).
  const tracer = trace.getTracer('control');
  const spans = new WeakMap<object, Span>();
  app.addHook('onRequest', async (req) => {
    const parent = propagation.extract(context.active(), req.headers);
    spans.set(req.raw, tracer.startSpan(`trpc ${req.url.split('?')[0]?.replace('/trpc/', '') ?? ''}`, undefined, parent));
  });
  app.addHook('onResponse', async (req, reply) => {
    const span = spans.get(req.raw);
    span?.setAttribute('http.status_code', reply.statusCode);
    span?.end();
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async () => ({ status: 'ready' }));

  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: async ({ req }): Promise<Context> => {
        const raw = req.headers[PRINCIPAL_HEADER];
        let principal: PrincipalClaims | null = null;
        if (typeof raw === 'string' && raw.length > 0) {
          try {
            principal = await options.verifier.verify(raw);
          } catch (error) {
            if (error instanceof PrincipalAssertionError) {
              throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid principal assertion' });
            }
            throw error;
          }
        }
        return { deps: options.deps, principal, span: spans.get(req.raw) };
      },
      onError: ({ error, path }) => {
        if (error.code === 'INTERNAL_SERVER_ERROR') {
          options.deps.logger.error({ err: error.cause ?? error, path }, 'control procedure failed');
        }
      },
    } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
  });

  return app;
}
