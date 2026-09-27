import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';
import type { JSONWebKeySet } from 'jose';
import { BRAND, problems, type Logger } from '@vega/shared';
import { context, propagation, tenantAttributes, trace, type Span } from '@vega/telemetry';
import type { OidcClient } from '@vega/idp';
import type { ControlClientFactory } from './control-client.js';
import { sendProblem, toProblem, type RouteHooks } from './http.js';
import { claim, complete, KEY_PATTERN, requestHash } from './idempotency.js';
import { consume, type RateStore } from './rate-limit.js';
import { Sealer } from './sealed.js';
import type { SessionService } from './sessions.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerConnectorRoutes } from './routes/connectors.js';
import { registerProgramRoutes } from './routes/programs.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerPolicyRoutes } from './routes/policies.js';
import { registerResourceRoutes } from './routes/resources.js';
import { registerSystemRoutes } from './routes/system.js';

/**
 * The public gateway — module1.md §5.1: "Public /v1 REST, authn, tenant resolution, rate
 * limiting". Every request that reaches the control plane has, by then:
 *   1. a session resolved from an opaque token (never a tenant id from the request)
 *   2. passed its token and tenant rate budgets
 *   3. for mutations, claimed its Idempotency-Key
 * and carries a signed principal assertion minted here.
 */

export interface GatewayDeps {
  logger: Logger;
  sessions: SessionService;
  controlFor: ControlClientFactory;
  rateStore: RateStore;
  /** Absent when the IdP is not configured; sign-in routes then return 503. */
  oidc?: OidcClient;
  /** Public keys this gateway signs with (principal assertions, run tokens). */
  jwks: JSONWebKeySet;
  config: {
    publicUrl: string;
    webUrl: string;
    sessionSecret: string;
    cookieSecure: boolean;
    ttlSeconds: number;
    rateLimits: { tenant: number; token: number; anon: number };
    signupAllowPassword: boolean;
  };
}

export function sessionCookieName(secure: boolean): string {
  // __Host- binds the cookie to this exact origin: no Domain attribute, Path=/, Secure.
  return secure ? `__Host-${BRAND.slug}_session` : `${BRAND.slug}_session`;
}

export async function buildGateway(deps: GatewayDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    trustProxy: true,
    // One validation path: Zod (http.ts). Fastify's schemas exist for OpenAPI only.
    ajv: { customOptions: { strict: false } },
  });
  app.setValidatorCompiler(() => (data) => ({ value: data }));
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));

  await app.register(cookie);

  // ------------------------------------------------------------------ OpenAPI
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: { title: `${BRAND.name} API`, version: 'v1', description: BRAND.tagline },
      components: {
        securitySchemes: {
          sessionCookie: { type: 'apiKey', in: 'cookie', name: sessionCookieName(deps.config.cookieSecure) },
          bearer: { type: 'http', scheme: 'bearer', description: 'Session token from POST /v1/auth/token' },
        },
      },
    },
  });
  app.addSchema({
    $id: 'Problem',
    type: 'object',
    description: 'RFC 9457 Problem Details',
    properties: {
      type: { type: 'string' },
      title: { type: 'string' },
      status: { type: 'integer' },
      detail: { type: 'string' },
      instance: { type: 'string' },
      errors: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, message: { type: 'string' } } } },
    },
    required: ['type', 'title', 'status'],
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  // ------------------------------------------------------------------ metrics
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const requests = new Counter({
    name: 'http_requests_total',
    help: 'Requests by route, method and status',
    labelNames: ['route', 'method', 'status'],
    registers: [registry],
  });
  const latency = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Request latency by route',
    labelNames: ['route', 'method'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  const authFailures = new Counter({
    name: 'auth_failures_total',
    help: 'Authentication failures by reason (module1.md §12 alert: spike)',
    labelNames: ['reason'],
    registers: [registry],
  });

  // ------------------------------------------------------------------ tracing
  const tracer = trace.getTracer('gateway');
  const spans = new WeakMap<FastifyRequest, { span: Span; started: number }>();

  app.addHook('onRequest', async (req, reply) => {
    const parent = propagation.extract(context.active(), req.headers);
    const span = tracer.startSpan(`${req.method} ${req.routeOptions.url ?? req.url}`, undefined, parent);
    const traceId = span.spanContext().traceId;
    req.traceId = traceId;
    spans.set(req, { span, started: performance.now() });
    reply.header('x-trace-id', traceId);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    // module1.md §10 headers. The API serves JSON, so the CSP is maximally strict.
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (!req.url.startsWith('/docs')) {
      reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    }
    if (deps.config.cookieSecure) {
      reply.header('strict-transport-security', 'max-age=63072000; includeSubDomains');
    }
    if (req.url.startsWith('/v1/')) reply.header('cache-control', 'no-store');
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    requests.inc({ route, method: req.method, status: String(reply.statusCode) });
    const s = spans.get(req);
    if (s) {
      latency.observe({ route, method: req.method }, (performance.now() - s.started) / 1000);
      s.span.setAttribute('http.status_code', reply.statusCode);
      s.span.end();
    }
  });

  // ------------------------------------------------------------------ errors
  app.setErrorHandler((error, req, reply) => {
    const problem = toProblem(error, deps.logger.child({ trace_id: req.traceId }));
    if (problem.status === 401) authFailures.inc({ reason: 'control_refused' });
    return sendProblem(reply, problem, req.url);
  });
  app.setNotFoundHandler((req, reply) => sendProblem(reply, problems.notFound(`no route ${req.method} ${req.url}`)));

  // ------------------------------------------------------------------ hooks
  const cookieName = sessionCookieName(deps.config.cookieSecure);

  const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    const fromCookie = req.cookies[cookieName];
    const token = bearer ?? fromCookie;
    if (!token) {
      authFailures.inc({ reason: 'missing' });
      return sendProblem(reply, problems.unauthorized('no session'));
    }

    // Cookie sessions rotate transparently. Bearer clients rotate explicitly via
    // POST /v1/auth/refresh, because they cannot be handed a new token mid-request.
    const resolved = await deps.sessions.resolve(token, { forceRotate: false });
    if (!resolved) {
      authFailures.inc({ reason: 'invalid' });
      if (!bearer && fromCookie) reply.clearCookie(cookieName, { path: '/' });
      return sendProblem(reply, problems.unauthorized('session is not valid'));
    }
    if (resolved.rotatedToken && !bearer) {
      reply.setCookie(cookieName, resolved.rotatedToken, sessionCookieOptions(deps, resolved.expiresAt));
    }

    req.principal = { sessionId: resolved.sessionId, tenantId: resolved.tenantId, userId: resolved.userId };
    // module1.md §12: every span carrying tenant context is tagged with it, so a trace can be
    // filtered to one tenant and correlated with its logs (and, from M7, its audit entries).
    const current = spans.get(req)?.span;
    current?.setAttributes(tenantAttributes({ tenantId: resolved.tenantId, userId: resolved.userId }));
    // Propagate THIS span as the parent of the control-plane span (W3C traceparent).
    const carrier: Record<string, string> = {};
    if (current) propagation.inject(trace.setSpan(context.active(), current), carrier);
    const traceparent = carrier['traceparent'] ?? req.headers['traceparent'];
    req.control = deps.controlFor(
      {
        tenantId: resolved.tenantId,
        userId: resolved.userId,
        sessionId: resolved.sessionId,
        ...(req.traceId ? { traceId: req.traceId } : {}),
      },
      typeof traceparent === 'string' ? traceparent : undefined,
    );
  };

  const rateLimit = async (req: FastifyRequest, reply: FastifyReply) => {
    const limits = deps.config.rateLimits;
    const budgets = req.principal
      ? [
          { key: `token:${req.principal.sessionId}`, limit: limits.token },
          { key: `tenant:${req.principal.tenantId}`, limit: limits.tenant },
        ]
      : [{ key: `anon:${req.ip}`, limit: limits.anon }];
    let retryAfter: number | undefined;
    try {
      retryAfter = await consume(deps.rateStore, budgets);
    } catch (error) {
      // Fail open on a limiter outage: rate limiting protects capacity, not data, and a
      // Valkey blip must not take the API down with it.
      deps.logger.warn({ err: error }, 'rate limiter unavailable; allowing request');
    }
    if (retryAfter !== undefined) {
      reply.header('retry-after', String(retryAfter));
      return sendProblem(reply, problems.rateLimited(retryAfter));
    }
  };

  const IDEM = Symbol('idempotency');
  type IdemState = { tenantId: string; principalId: string; key: string };

  const idempotency = async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = req.headers['idempotency-key'];
    if (raw === undefined || !req.principal) return;
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (!key || !KEY_PATTERN.test(key)) {
      return sendProblem(reply, problems.validation([{ path: 'headers.idempotency-key', message: '1-255 printable ASCII characters' }]));
    }
    const state: IdemState = { tenantId: req.principal.tenantId, principalId: req.principal.userId, key };
    const result = await claim({
      ...state,
      method: req.method,
      path: req.url.split('?')[0] ?? req.url,
      hash: requestHash(req.method, req.url, req.body),
    });
    switch (result.kind) {
      case 'fresh':
        (req as unknown as Record<symbol, IdemState>)[IDEM] = state;
        return;
      case 'replay':
        reply.header('idempotent-replayed', 'true');
        return reply.code(result.status).type('application/json').send(result.body);
      case 'in_progress':
        return sendProblem(reply, problems.conflict('a request with this Idempotency-Key is still in progress'));
      case 'mismatch':
        return sendProblem(
          reply,
          problems.idempotencyConflict('this Idempotency-Key was used for a different request'),
        );
    }
  };

  app.addHook('onSend', async (req, reply, payload) => {
    const state = (req as unknown as Record<symbol, IdemState | undefined>)[IDEM];
    if (!state) return payload;
    let body: unknown = null;
    try {
      body = typeof payload === 'string' && payload.length ? JSON.parse(payload) : null;
    } catch {
      body = null;
    }
    await complete(state, reply.statusCode, body).catch((error: unknown) =>
      deps.logger.error({ err: error }, 'failed to record idempotent response'),
    );
    return payload;
  });

  const hooks: RouteHooks = { authenticate, rateLimit, idempotency };

  // ------------------------------------------------------------------ routes
  const loginSealer = new Sealer(deps.config.sessionSecret, 'oidc-login-state');
  registerSystemRoutes(app, { registry, jwks: deps.jwks });
  registerAuthRoutes(app, hooks, deps, { loginSealer, cookieName });
  registerResourceRoutes(app, hooks, deps);
  registerConnectorRoutes(app, hooks, deps);
  registerProgramRoutes(app, hooks, deps);
  registerRunRoutes(app, hooks, deps);
  registerPolicyRoutes(app, hooks, deps);

  return app;
}

export function sessionCookieOptions(deps: GatewayDeps, expiresAt: Date) {
  return {
    path: '/',
    httpOnly: true,
    secure: deps.config.cookieSecure,
    sameSite: 'lax' as const,
    expires: expiresAt,
  };
}
