import { initTRPC, TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import type { Logger } from '@vega/shared';
import { problems, type Problem } from '@vega/shared';
import { schema, withTenant, type Db } from '@vega/db';
import {
  hasCapability,
  tuple,
  type Capability,
  type FgaClient,
  type Role,
} from '@vega/authz';
import type { IdentityAdmin, PrincipalClaims } from '@vega/idp';
import type { ExposedFeatures, PlanLimits } from '@vega/contracts';
import { tenantAttributes, type Span } from '@vega/telemetry';
import type { ConnectorDeps } from './connectors/deps.js';
import type { AgentCoreDeps, RunCoordinator } from './agent/coordinator.js';
import type { PolicyPublisher } from './policy/publisher.js';
import type { ReversibilityStore } from '@vega/compensators';

/**
 * Control-plane RPC.
 *
 * Every procedure is authenticated: there is no public procedure in this router. The context
 * is built from a PrincipalAssertion the gateway signed (see app.ts); by the time a resolver
 * runs, the tenant has been resolved from a verified claim and the user row has been re-read
 * under that tenant — so a user deactivated a second ago is refused now, not at session expiry.
 */

export interface ControlDeps {
  identity: IdentityAdmin;
  fga: FgaClient;
  logger: Logger;
  /** Development only: return invite codes in the API response instead of emailing them. */
  returnInviteCodes?: boolean;
  /** Module 2. Absent: connector procedures answer 503. */
  connectors?: ConnectorDeps;
  /** Module 4: intent, planning and the run coordinator. Absent: run procedures answer 503. */
  agent?: { core: AgentCoreDeps; coordinator: RunCoordinator };
  /** Module 5: signing and distributing policy bundles. Absent: build/activate answer 503. */
  policy?: { publisher: PolicyPublisher };
  /** Module 6: the reversibility store and the fast revoke cache (Valkey). */
  reversibility?: { store: ReversibilityStore; cache?: FastRevokeLookup | undefined; pushSecret?: string | undefined };
}

/** The read half of the fast revoke path (execution writes it when a hold opens). */
export interface FastRevokeLookup {
  get(key: string): Promise<string | null>;
}

export interface Principal extends PrincipalClaims {
  role: Role;
  email: string;
}

export interface Context {
  deps: ControlDeps;
  principal: PrincipalClaims | null;
  /** The OTel span for this request; the authed middleware tags it with the tenant. */
  span?: Span | undefined;
}

export interface AuthedContext extends Context {
  principal: Principal;
  plan: string;
  entitlements: { limits: PlanLimits; exposed: ExposedFeatures };
  /** Runs `fn` under this request's tenant. The ONLY way procedures touch the database. */
  db: <T>(fn: (db: Db) => Promise<T>) => Promise<T>;
  log: Logger;
}

/**
 * tRPC error carrying an RFC 9457 problem. The gateway renders `cause.problem` verbatim, so
 * the stable `type` URI a client branches on is decided here, next to the rule that failed.
 */
export class ProblemError extends TRPCError {
  constructor(readonly problem: Problem) {
    super({ code: codeFor(problem.status), message: problem.title, cause: new ProblemCause(problem) });
  }
}

export class ProblemCause extends Error {
  constructor(readonly problem: Problem) {
    super(problem.title);
    this.name = 'ProblemCause';
  }
}

function codeFor(status: number): TRPCError['code'] {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'UNPROCESSABLE_CONTENT';
    case 428:
      return 'PRECONDITION_FAILED';
    case 429:
      return 'TOO_MANY_REQUESTS';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return 'INTERNAL_SERVER_ERROR';
  }
}

/**
 * Input that fails its Zod contract is a 400 with field-level errors, in the same RFC 9457
 * shape as every other failure — so a client handles "bad input" one way, whichever layer
 * caught it.
 */
function validationProblem(cause: unknown): Problem | undefined {
  const issues = (cause as { issues?: Array<{ path?: PropertyKey[]; message: string }> } | undefined)?.issues;
  if (!Array.isArray(issues)) return undefined;
  return problems.validation(
    issues.map((i) => ({ path: (i.path ?? []).map(String).join('.'), message: i.message })),
  );
}

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    const cause = error.cause;
    const problem =
      cause instanceof ProblemCause
        ? cause.problem
        : error.code === 'BAD_REQUEST'
          ? validationProblem(cause)
          : undefined;
    return { ...shape, data: { ...shape.data, problem } };
  },
});

export const router = t.router;
export const middleware = t.middleware;

/**
 * Resolves the principal. Refuses with `tenant-context-missing` — an invariant violation,
 * not a 401 — if a procedure is reached with no verified principal, because the gateway
 * never forwards an unauthenticated request here. Reaching this branch means a routing bug.
 */
const authed = t.middleware(async ({ ctx, next }) => {
  const claims = ctx.principal;
  if (!claims) throw new ProblemError(problems.tenantContextMissing());
  // A system principal has no tenant; it may only reach procedures built on systemProcedure.
  if (claims.system) throw new ProblemError(problems.forbidden('system principal not admitted here'));

  const tenantId = claims.tenantId;
  const loaded = await withTenant(tenantId, async (db) => {
    const [user] = await db
      .select({
        id: schema.users.id,
        role: schema.users.role,
        status: schema.users.status,
        email: schema.users.email,
      })
      .from(schema.users)
      .where(eq(schema.users.id, claims.userId));
    const [tenant] = await db
      .select({ plan: schema.tenants.plan, status: schema.tenants.status })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, tenantId));
    const [ent] = tenant
      ? await db
          .select()
          .from(schema.planEntitlements)
          .where(eq(schema.planEntitlements.plan, tenant.plan))
      : [];
    return { user, tenant, ent };
  });

  // RLS makes a cross-tenant (tenant, user) pair indistinguishable from a missing user.
  if (!loaded.user || !loaded.tenant) throw new ProblemError(problems.unauthorized('principal not found'));
  if (loaded.user.status !== 'active') throw new ProblemError(problems.unauthorized('user is not active'));
  if (loaded.tenant.status !== 'active') throw new ProblemError(problems.forbidden('tenant is not active'));
  if (!loaded.ent) throw new ProblemError(problems.internal());

  ctx.span?.setAttributes(tenantAttributes({ tenantId, userId: claims.userId }));
  const principal: Principal = {
    ...claims,
    role: loaded.user.role as Role,
    email: loaded.user.email,
  };
  const log = ctx.deps.logger.child({
    tenant_id: tenantId,
    user_id: claims.userId,
    ...(claims.traceId ? { trace_id: claims.traceId } : {}),
  });

  return next({
    ctx: {
      ...ctx,
      principal,
      plan: loaded.tenant.plan,
      entitlements: {
        limits: loaded.ent.limits as PlanLimits,
        exposed: loaded.ent.exposed as ExposedFeatures,
      },
      db: <T>(fn: (db: Db) => Promise<T>) => withTenant(tenantId, fn),
      log,
    } satisfies AuthedContext,
  });
});

export const procedure = t.procedure.use(authed);

/** Procedures reachable by the signup system principal and by nothing else. */
export const signupProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (ctx.principal?.system !== 'signup') {
    throw new ProblemError(problems.forbidden('signup principal required'));
  }
  return next({ ctx: { ...ctx, log: ctx.deps.logger.child({ system: 'signup' }) } });
});

/** The inbound agent-webhook principal (Module 4) and nothing else. */
export const webhookProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (ctx.principal?.system !== 'webhook') throw new ProblemError(problems.forbidden('webhook principal required'));
  return next({ ctx: { ...ctx, log: ctx.deps.logger.child({ system: 'webhook' }) } });
});

/** Module 6: the one-tap revoke capability (from a push), and nothing else. */
export const holdRevokeProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (ctx.principal?.system !== 'hold_revoke') throw new ProblemError(problems.forbidden('hold revoke principal required'));
  return next({ ctx: { ...ctx, log: ctx.deps.logger.child({ system: 'hold_revoke' }) } });
});

/** Capability gate (layer 1 of 2 — see packages/authz/src/roles.ts). */
export function requireCapability(ctx: AuthedContext, capability: Capability): void {
  if (!hasCapability(ctx.principal.role, capability)) {
    throw new ProblemError(problems.forbidden(`role ${ctx.principal.role} lacks ${capability}`));
  }
}

/** Relationship gate (layer 2 of 2). An OpenFGA error is a denial, never an allow. */
export async function requireRelation(
  ctx: AuthedContext,
  relation: string,
  object: string,
): Promise<void> {
  let allowed = false;
  try {
    allowed = await ctx.deps.fga.check(tuple(`user:${ctx.principal.userId}`, relation, object));
  } catch (error) {
    ctx.log.error({ err: error, relation, object }, 'authorization check failed; denying');
    throw new ProblemError(problems.upstreamUnavailable('authorization'));
  }
  if (!allowed) throw new ProblemError(problems.forbidden(`not permitted: ${relation} on ${object}`));
}

/**
 * Exposure gate (decision D-09). Entitlements decide which SURFACES a plan reaches, never
 * how the engine behaves. Note the type: undo and taint defense are not keys of
 * ExposedFeatures, so they cannot be passed here (D-10).
 */
export function requireExposed(ctx: AuthedContext, feature: keyof ExposedFeatures): void {
  if (!ctx.entitlements.exposed[feature]) {
    throw new ProblemError(problems.entitlementRequired(feature));
  }
}
