import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { TRPCClientError } from '@trpc/client';
import { z } from 'zod';
import { problems, VegaError, type Logger, type Problem } from '@vega/shared';
import type { ControlClient } from './control-client.js';
import type { SessionPrincipal } from './sessions.js';

/**
 * Route definition helper: ONE Zod schema per part drives validation, types, and OpenAPI.
 *
 * Fastify's own validator is switched off (app.ts) so there is exactly one validation path,
 * and it is the same Zod contract the control plane and the web app use (module1.md §6.3).
 * The JSON Schema Fastify sees is generated from Zod purely for the OpenAPI document.
 */

declare module 'fastify' {
  interface FastifyRequest {
    principal?: SessionPrincipal;
    control?: ControlClient;
    traceId?: string;
  }
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface HandlerCtx<P, Q, B> {
  req: FastifyRequest;
  reply: FastifyReply;
  params: P;
  query: Q;
  body: B;
}

export interface AuthedCtx<P, Q, B> extends HandlerCtx<P, Q, B> {
  principal: SessionPrincipal;
  control: ControlClient;
}

type Infer<T> = T extends z.ZodType ? z.infer<T> : undefined;

export interface RouteSpec<
  P extends z.ZodType | undefined,
  Q extends z.ZodType | undefined,
  B extends z.ZodType | undefined,
  A extends boolean,
> {
  method: Method;
  url: string;
  summary: string;
  tags: string[];
  /** Default true. Unauthenticated routes are the login flow, signup, and health only. */
  auth?: A;
  params?: P;
  query?: Q;
  body?: B;
  response?: z.ZodType;
  successStatus?: number;
  handler: (
    ctx: A extends false ? HandlerCtx<Infer<P>, Infer<Q>, Infer<B>> : AuthedCtx<Infer<P>, Infer<Q>, Infer<B>>,
  ) => Promise<unknown>;
}

export interface RouteHooks {
  authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  rateLimit: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  idempotency: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

const toJson = (schema: z.ZodType, io: 'input' | 'output') =>
  z.toJSONSchema(schema, { target: 'openapi-3.0', io, unrepresentable: 'any' }) as Record<string, unknown>;

export class RequestValidationError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.title);
  }
}

function parse<T extends z.ZodType>(schema: T | undefined, value: unknown, where: string) {
  if (!schema) return undefined;
  const result = schema.safeParse(value ?? (where === 'body' ? undefined : {}));
  if (!result.success) {
    throw new RequestValidationError(
      problems.validation(
        result.error.issues.map((i) => ({
          path: [where, ...i.path.map(String)].join('.'),
          message: i.message,
        })),
      ),
    );
  }
  return result.data;
}

export function defineRoute<
  P extends z.ZodType | undefined = undefined,
  Q extends z.ZodType | undefined = undefined,
  B extends z.ZodType | undefined = undefined,
  A extends boolean = true,
>(app: FastifyInstance, hooks: RouteHooks, spec: RouteSpec<P, Q, B, A>): void {
  const authed = spec.auth !== false;
  const mutating = spec.method !== 'GET';
  const status = spec.successStatus ?? (spec.method === 'POST' ? 201 : 200);

  const preHandler = authed
    ? [hooks.authenticate, hooks.rateLimit, ...(mutating ? [hooks.idempotency] : [])]
    : [hooks.rateLimit];

  app.route({
    method: spec.method,
    url: spec.url,
    schema: {
      summary: spec.summary,
      tags: spec.tags,
      ...(spec.params ? { params: toJson(spec.params, 'input') } : {}),
      ...(spec.query ? { querystring: toJson(spec.query, 'input') } : {}),
      ...(spec.body ? { body: toJson(spec.body, 'input') } : {}),
      ...(authed ? { security: [{ sessionCookie: [] }, { bearer: [] }] } : {}),
      ...(mutating && authed
        ? {
            headers: {
              type: 'object',
              properties: {
                'idempotency-key': { type: 'string', maxLength: 255, description: 'Stored 24h; replays return the first response.' },
              },
            },
          }
        : {}),
      response: {
        [status]: spec.response ? toJson(spec.response, 'output') : { type: 'object', additionalProperties: true },
        default: { $ref: 'Problem#' },
      },
    },
    preHandler,
    handler: async (req, reply) => {
      const params = parse(spec.params, req.params, 'params');
      const query = parse(spec.query, req.query, 'query');
      const body = parse(spec.body, req.body, 'body');
      const base = { req, reply, params, query, body };
      const ctx = authed ? { ...base, principal: req.principal!, control: req.control! } : base;
      const result = await spec.handler(ctx as never);
      if (reply.sent) return reply;
      return reply.code(status).send(result ?? { ok: true });
    },
  });
}

/** tRPC/Fastify/Vega errors → RFC 9457. One mapping, used by the global error handler. */
export function toProblem(error: unknown, log: Logger): Problem {
  if (error instanceof RequestValidationError) return error.problem;
  if (error instanceof VegaError) return error.problem;

  if (error instanceof TRPCClientError) {
    const data = error.data as { problem?: Problem; httpStatus?: number; code?: string } | undefined;
    if (data?.problem) return data.problem;
    switch (data?.code) {
      case 'UNAUTHORIZED':
        return problems.unauthorized();
      case 'FORBIDDEN':
        return problems.forbidden();
      case 'NOT_FOUND':
        return problems.notFound();
      case 'CONFLICT':
        return problems.conflict();
      case 'TOO_MANY_REQUESTS':
        return problems.rateLimited(1);
      default:
        break;
    }
    if (!data) {
      // No tRPC envelope at all: the control plane was unreachable.
      log.error({ err: error }, 'control plane unreachable');
      return problems.upstreamUnavailable('control plane');
    }
    log.error({ err: error }, 'control plane error');
    return problems.internal();
  }

  const fe = error as FastifyError;
  if (typeof fe?.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode < 500) {
    return { type: 'about:blank', title: fe.message || 'Bad request', status: fe.statusCode };
  }
  log.error({ err: error }, 'unhandled gateway error');
  return problems.internal();
}

export function sendProblem(reply: FastifyReply, problem: Problem, instance?: string) {
  return reply
    .code(problem.status)
    .type('application/problem+json')
    .send({ ...problem, ...(instance ? { instance } : {}) });
}
